import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { approveChange, requestChange } from "../src/flows/change.js";
import type { Deps, Notifier } from "../src/flows/context.js";
import { handleReviewerMention } from "../src/flows/review.js";
import { codexArgs, parseReview, type ReviewResult } from "../src/integrations/codex.js";
import { configureGitIdentity } from "../src/integrations/github.js";
import { Store } from "../src/store.js";
import { exec } from "../src/util/exec.js";
import { SerialQueue } from "../src/util/serial.js";

/** 로컬 bare 레포를 원격처럼 쓰는 가짜 GitHub */
function fakeGitHub(remote: string) {
  const prs: Array<{ number: number; head: string; state: string; body?: string }> = [];
  const issues: Array<{ number: number; title: string; body: string; state: string; comments: string[] }> = [];
  const board: Array<{ number: number; status?: string }> = [];
  return {
    prs,
    issues,
    board,
    failIssues: false,
    async createIssue(this: { failIssues: boolean }, _repo: string, title: string, body: string) {
      if (this.failIssues) throw Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 });
      // 이슈와 PR 은 번호를 공유한다 (GitHub 과 같게)
      const number = issues.length + prs.length + 1;
      issues.push({ number, title, body, state: "open", comments: [] });
      return number;
    },
    async commentIssue(_repo: string, n: number, body: string) {
      issues.find((i) => i.number === n)!.comments.push(body);
    },
    async closeIssue(_repo: string, n: number, reason: string) {
      issues.find((i) => i.number === n)!.state = `closed:${reason}`;
    },
    async addToProject(_projectId: string, _repo: string, number: number, status?: string) {
      board.push({ number, status });
    },
    owner: "me",
    authedUrl: () => remote,
    async clone(_repo: string, dir: string, branch?: string) {
      await exec("git", ["clone", ...(branch ? ["--branch", branch] : []), remote, dir]);
      await configureGitIdentity(dir);
    },
    async push(dir: string, branch: string) {
      await exec("git", ["push", "-u", "origin", branch], { cwd: dir });
    },
    async openPr(_repo: string, head: string, _title: string, body: string) {
      const number = issues.length + prs.length + 1;
      prs.push({ number, head, state: "open", body });
      return number;
    },
    async mergePr(_repo: string, n: number) {
      prs.find((p) => p.number === n)!.state = "merged";
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
    async archiveChannel() {},
  };
  return { notifier, posts };
}


/** 앱 작업 줄이 빌 때까지 기다린다 (리뷰 → 반영 → 리뷰가 줄 뒤에 계속 붙는다) */
async function drain(deps: Deps, slug: string): Promise<void> {
  while (deps.queue.pending(slug)) await deps.queue.run(slug, async () => undefined);
}

const CHANGES: ReviewResult = {
  verdict: "changes_requested",
  summary: "입력 검증이 빠졌어요.",
  findings: [
    { severity: "must", file: "README.md", line: 3, issue: "빈 값 처리 없음", suggestion: "빈 값이면 막기" },
    { severity: "nit", file: "README.md", line: null, issue: "줄바꿈", suggestion: "" },
  ],
};
const APPROVE: ReviewResult = { verdict: "approve", summary: "좋아요.", findings: [] };

describe("리뷰어 ↔ 파피 왕복", () => {
  let deps: Deps;
  let gh: ReturnType<typeof fakeGitHub>;
  let papi: ReturnType<typeof fakeNotifier>["posts"];
  let reviewer: ReturnType<typeof fakeNotifier>["posts"];
  let agentPrompts: string[];
  let reviewPrompts: Array<{ cwd: string; prompt: string }>;
  let verdicts: ReviewResult[];
  let agentEdits: boolean;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-review-"));
    const remote = join(root, "remote.git");
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
    // PR 댓글도 이슈 댓글과 같은 API (GitHub 과 같게)
    const prComments: Record<number, string[]> = {};
    (gh as unknown as { prComments: typeof prComments }).prComments = prComments;
    const commentIssue = gh.commentIssue;
    gh.commentIssue = async (repo: string, n: number, body: string) => {
      if (gh.prs.some((p) => p.number === n)) (prComments[n] ??= []).push(body);
      else await commentIssue(repo, n, body);
    };
    const a = fakeNotifier();
    const b = fakeNotifier();
    papi = a.posts;
    reviewer = b.posts;
    agentPrompts = [];
    reviewPrompts = [];
    verdicts = [];
    agentEdits = true;
    deps = {
      config: {
        WORKSPACE_DIR: join(root, "ws"),
        CLAUDE_MODEL: "test-model",
        AGENT_MAX_BUDGET_USD: 1,
        REVIEW_MAX_ROUNDS: 2,
        CODEX_BIN: "codex",
      } as Config,
      store: new Store(":memory:"),
      claude: {} as never,
      github: gh as never,
      vercel: { waitForCommit: async () => ({ url: "https://preview.example", state: "READY" }) } as never,
      notifier: a.notifier,
      reviewerNotifier: b.notifier,
      queue: new SerialQueue(),
      runAgent: async (opts) => {
        agentPrompts.push(opts.prompt);
        if (agentEdits) {
          const file = join(opts.cwd, "README.md");
          await writeFile(file, (await readFile(file, "utf8")) + `\n- ${agentPrompts.length}\n`);
        }
        return { ok: true, summary: `파피 요약 ${agentPrompts.length}`, costUsd: 0, turns: 1 };
      },
      runReview: async (opts) => {
        reviewPrompts.push({ cwd: opts.cwd, prompt: opts.prompt });
        return verdicts.shift() ?? APPROVE;
      },
    };
  });

  function demoApp() {
    const app = deps.store.createApp({ slug: "demo", name: "Demo", idea: "i", repo: "me/demo", created_by: "U1" });
    deps.store.updateApp(app.id, { slack_channel_id: "C1", vercel_project_id: "prj", status: "ready" });
    return deps.store.getApp(app.id)!;
  }

  it("PR 을 올리면 리뷰어가 리뷰하고, 지적이 있으면 파피가 고치고 다시 리뷰 (Slack 스레드 + PR 댓글)", async () => {
    const app = demoApp();
    verdicts = [CHANGES, APPROVE];
    await requestChange(deps, app, { threadTs: "T1", userId: "U1", request: "폼 추가" });
    await drain(deps, app.slug);

    const change = deps.store.getOpenChangeByThread(app.id, "T1")!;
    expect(change.status).toBe("preview");
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[0].prompt).toContain("폼 추가");
    expect(reviewPrompts[0].prompt).toContain("README.md"); // diff 가 들어간다
    // 2차 리뷰에는 1차 지적과 파피 반영이 들어간다 (맥락 유지)
    expect(reviewPrompts[1].prompt).toContain("빈 값 처리 없음");
    expect(reviewPrompts[1].prompt).toContain("파피 요약 2");

    // 파피 반영 프롬프트: must 만, nit 은 빼고
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[1]).toContain("빈 값 처리 없음");
    expect(agentPrompts[1]).not.toContain("줄바꿈");

    // 모든 글이 같은 스레드에
    expect(reviewer.every((p) => p.threadTs === "T1" || p.text.startsWith("[update"))).toBe(true);
    expect(reviewer.some((p) => p.text.includes("1차 리뷰: 고칠 게 있어요"))).toBe(true);
    expect(reviewer.some((p) => p.text.includes("2차 리뷰: 머지해도 좋아 보여요"))).toBe(true);
    expect(papi.some((p) => p.text.includes("리뷰어 1차 지적 반영할게요"))).toBe(true);

    const prComments = (gh as unknown as { prComments: Record<number, string[]> }).prComments[change.pr_number!];
    expect(prComments.map((c) => c.split("\n")[0])).toEqual([
      expect.stringContaining("리뷰어 (Codex) · 1차 리뷰 · 📝"),
      expect.stringContaining("파피 · 1차 리뷰 반영 · 커밋"),
      expect.stringContaining("리뷰어 (Codex) · 2차 리뷰 · ✅"),
    ]);

    // 브랜치: 처음 커밋 + 리뷰 반영 커밋
    const log = await exec("git", ["log", "--oneline", "main.." + change.branch], { cwd: join(deps.config.WORKSPACE_DIR, "..", "remote.git") });
    expect(log.stdout.trim().split("\n")).toHaveLength(2);

    await approveChange(deps, change.id, "U2");
    expect(deps.store.getChange(change.id)!.status).toBe("merged");
  });

  it("계속 지적이 나오면 REVIEW_MAX_ROUNDS 번 고치고 멈춰서 사람에게 넘긴다", async () => {
    const app = demoApp();
    verdicts = [CHANGES, CHANGES, CHANGES, CHANGES];
    await requestChange(deps, app, { threadTs: "T2", userId: "U1", request: "결제" });
    await drain(deps, app.slug);
    expect(reviewPrompts).toHaveLength(3); // 리뷰 → 고침 → 리뷰 → 고침 → 리뷰(마지막)
    expect(agentPrompts).toHaveLength(3); // 처음 + 반영 2번
    expect(papi.at(-1)!.text).toContain("2번 주고받았어요");

    // 사람이 다시 요청하면 왕복을 처음부터
    verdicts = [APPROVE];
    await requestChange(deps, app, { threadTs: "T2", userId: "U1", request: "문구도" });
    await drain(deps, app.slug);
    expect(deps.store.getOpenChangeByThread(app.id, "T2")!.review_rounds).toBe(1);
  });

  it("파피가 지적에 동의하지 않아 코드를 안 바꾸면 왕복을 끝낸다", async () => {
    const app = demoApp();
    verdicts = [CHANGES];
    await requestChange(deps, app, { threadTs: "T3", userId: "U1", request: "목록" });
    agentEdits = false;
    await drain(deps, app.slug);
    expect(reviewPrompts).toHaveLength(1);
    expect(papi.some((p) => p.text.includes("코드를 바꾸지 않았어요"))).toBe(true);
    const change = deps.store.getOpenChangeByThread(app.id, "T3")!;
    expect(change.status).toBe("preview");
    expect(deps.store.listReviews(change.id)[0].fix_summary).toContain("파피 요약");
  });

  it("@리뷰어: PR 스레드면 다시 리뷰, 아니면 안내", async () => {
    const app = demoApp();
    await handleReviewerMention(deps, { channel: "C1", threadTs: "nope", userId: "U1", text: "" });
    expect(reviewer.at(-1)!.text).toContain("PR 스레드 안에서");

    await requestChange(deps, app, { threadTs: "T4", userId: "U1", request: "검색" });
    await drain(deps, app.slug);
    expect(reviewPrompts).toHaveLength(1);
    await handleReviewerMention(deps, { channel: "C1", threadTs: "T4", userId: "U1", text: "보안 위주로" });
    await drain(deps, app.slug);
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[1].prompt).toContain("보안 위주로");
  });

  it("리뷰어가 꺼져 있으면 기존 흐름 그대로", async () => {
    const app = demoApp();
    deps.runReview = undefined;
    await requestChange(deps, app, { threadTs: "T5", userId: "U1", request: "x" });
    await drain(deps, app.slug);
    expect(reviewPrompts).toHaveLength(0);
    expect(reviewer).toHaveLength(0);
  });
});

describe("codex 리뷰 러너", () => {
  it("읽기 전용 샌드박스·스키마·stdin 프롬프트로 실행", () => {
    const args = codexArgs({ cwd: "/w", schemaPath: "/t/s.json", outPath: "/t/o.json", model: "gpt-x" });
    expect(args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(args).toContain("--output-schema");
    expect(args).toContain("--ephemeral");
    expect(args.at(-1)).toBe("-");
    expect(args.join(" ")).toContain("--model gpt-x");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("코드펜스·앞뒤 말이 있어도 JSON 을 읽고, 이상한 값은 고친다", () => {
    const r = parseReview('결과:\n```json\n{"verdict":"changes_requested","summary":"s","findings":[{"severity":"big","file":"a.ts","line":"x","issue":"i","suggestion":""}]}\n```');
    expect(r.verdict).toBe("changes_requested");
    expect(r.findings[0]).toEqual({ severity: "should", file: "a.ts", line: null, issue: "i", suggestion: "" });
    expect(() => parseReview("모르겠어요")).toThrow(/읽지 못했어요/);
  });
});
