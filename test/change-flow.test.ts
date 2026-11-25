import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { approveChange, requestChange } from "../src/flows/change.js";
import type { Deps, Notifier } from "../src/flows/context.js";
import { configureGitIdentity } from "../src/integrations/github.js";
import { Store } from "../src/store.js";
import { exec } from "../src/util/exec.js";
import { SerialQueue } from "../src/util/serial.js";

/** 로컬 bare 레포를 원격처럼 쓰는 가짜 GitHub */
function fakeGitHub(remote: string) {
  const prs: Array<{ number: number; head: string; state: string }> = [];
  return {
    prs,
    owner: "me",
    authedUrl: () => remote,
    async clone(_repo: string, dir: string, branch?: string) {
      await exec("git", ["clone", ...(branch ? ["--branch", branch] : []), remote, dir]);
      await configureGitIdentity(dir);
    },
    async push(dir: string, branch: string) {
      await exec("git", ["push", "-u", "origin", branch], { cwd: dir });
    },
    async openPr(_repo: string, head: string) {
      prs.push({ number: prs.length + 1, head, state: "open" });
      return prs.length;
    },
    async mergePr(_repo: string, n: number) {
      prs[n - 1].state = "merged";
      return "merged-sha";
    },
    async closePr() {},
    async headSha(dir: string) {
      return (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    },
  };
}

function fakeNotifier() {
  const posts: Array<{ channel: string; text: string; threadTs?: string; blocks?: unknown[] }> = [];
  let n = 0;
  const notifier: Notifier = {
    async post(channel, text, opts = {}) {
      posts.push({ channel, text, ...opts });
      return `ts-${++n}`;
    },
    async update(channel, ts, text, blocks) {
      posts.push({ channel, text: `[update ${ts}] ${text}`, blocks });
    },
    async createChannel() {
      return "C-NEW";
    },
    async invite() {},
  };
  return { notifier, posts };
}

describe("요구사항 → PR → 승인 흐름", () => {
  let remote: string;
  let deps: Deps;
  let gh: ReturnType<typeof fakeGitHub>;
  let posts: ReturnType<typeof fakeNotifier>["posts"];
  let agentCalls: Array<{ cwd: string; prompt: string }>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-test-"));
    remote = join(root, "remote.git");
    const seed = join(root, "seed");
    await exec("git", ["init", "--bare", "-b", "main", remote]);
    await exec("git", ["init", "-b", "main", seed]);
    await configureGitIdentity(seed);
    await writeFile(join(seed, "README.md"), "# app\n");
    await exec("git", ["add", "-A"], { cwd: seed });
    await exec("git", ["commit", "-m", "init"], { cwd: seed });
    await exec("git", ["remote", "add", "origin", remote], { cwd: seed });
    await exec("git", ["push", "origin", "main"], { cwd: seed });

    gh = fakeGitHub(remote);
    const n = fakeNotifier();
    posts = n.posts;
    agentCalls = [];
    deps = {
      config: {
        WORKSPACE_DIR: join(root, "ws"),
        CLAUDE_MODEL: "test-model",
        AGENT_MAX_BUDGET_USD: 1,
      } as Config,
      store: new Store(":memory:"),
      claude: {} as never,
      github: gh as never,
      vercel: {
        waitForCommit: async () => ({ url: "https://preview.example", state: "READY" }),
      } as never,
      notifier: n.notifier,
      queue: new SerialQueue(),
      runAgent: async (opts) => {
        agentCalls.push({ cwd: opts.cwd, prompt: opts.prompt });
        const file = join(opts.cwd, "README.md");
        await writeFile(file, (await readFile(file, "utf8")) + `\n- ${agentCalls.length}\n`);
        opts.onProgress?.("✏️ README.md");
        return { ok: true, summary: `변경 ${agentCalls.length}`, costUsd: 0.5, turns: 3 };
      },
    };
  });

  it("새 요청은 PR을 열고, 같은 스레드 추가 요청은 같은 브랜치에 커밋, 승인하면 머지", async () => {
    const app = deps.store.createApp({ slug: "demo", name: "Demo", idea: "i", repo: "me/demo", created_by: "U1" });
    deps.store.updateApp(app.id, { slack_channel_id: "C1", vercel_project_id: "prj", status: "ready" });
    const ready = deps.store.getApp(app.id)!;

    await requestChange(deps, ready, { threadTs: "T1", userId: "U1", request: "Add hero section" });
    let change = deps.store.getOpenChangeByThread(app.id, "T1")!;
    expect(change.status).toBe("preview");
    expect(change.pr_number).toBe(1);
    expect(change.preview_url).toBe("https://preview.example");
    expect(change.branch).toBe("pipeline/1-add-hero-section");

    await requestChange(deps, ready, { threadTs: "T1", userId: "U1", request: "버튼 색 바꿔줘" });
    change = deps.store.getChange(change.id)!;
    expect(gh.prs).toHaveLength(1); // 새 PR 없이 이어서
    expect(change.cost_usd).toBeCloseTo(1.0);
    expect(agentCalls[1].prompt).toContain("Add hero section");
    const log = await exec("git", ["log", "--oneline", change.branch], { cwd: remote });
    expect(log.stdout.trim().split("\n")).toHaveLength(3);

    const lastBlocks = posts.filter((p) => p.blocks?.length).at(-1)!.blocks as Array<{ type: string }>;
    expect(lastBlocks.some((b) => b.type === "actions")).toBe(true);

    await approveChange(deps, change.id, "U2");
    expect(deps.store.getChange(change.id)!.status).toBe("merged");
    expect(gh.prs[0].state).toBe("merged");
    expect(posts.at(-1)!.text).toContain("프로덕션 배포 완료");

    // 두 번 눌러도 다시 머지하지 않는다
    await approveChange(deps, change.id, "U2");
    expect(posts.at(-1)!.text).toBe("이미 처리된 요청이에요.");
  });

  it("에이전트가 아무것도 안 바꾸면 PR을 만들지 않는다", async () => {
    deps.runAgent = async () => ({ ok: true, summary: "이미 돼 있어요", costUsd: 0.1, turns: 1 });
    const app = deps.store.createApp({ slug: "d2", name: "D2", idea: "i", repo: "me/d2", created_by: "U1" });
    deps.store.updateApp(app.id, { slack_channel_id: "C2" });
    await requestChange(deps, deps.store.getApp(app.id)!, { threadTs: "T9", userId: "U1", request: "noop" });
    expect(gh.prs).toHaveLength(0);
    expect(posts.at(-1)!.text).toContain("코드 변경 없이");
  });
});
