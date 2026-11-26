import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { connectRepo, parseRepoArg } from "../src/flows/connect.js";
import { deleteApp } from "../src/flows/delete.js";
import { Store } from "../src/store.js";
import { SerialQueue } from "../src/util/serial.js";

describe("parseRepoArg", () => {
  it("여러 형태를 owner/repo 로", () => {
    expect(parseRepoArg("mujuhoney", "SeongJinSong")).toBe("SeongJinSong/mujuhoney");
    expect(parseRepoArg("SeongJinSong/silverclub", "x")).toBe("SeongJinSong/silverclub");
    expect(parseRepoArg("<https://github.com/SeongJinSong/mujuhoney.git>", "x")).toBe("SeongJinSong/mujuhoney");
    expect(parseRepoArg("https://github.com/a/b/tree/main", "x")).toBe("a/b");
    expect(parseRepoArg("이상한 값", "x")).toBeNull();
  });
});

async function setup(opts: { vercel?: boolean; missing?: boolean } = {}) {
  const store = new Store(await mkdtemp(join(tmpdir(), "conn-")));
  const calls: string[] = [];
  const deps = {
    store,
    queue: new SerialQueue(),
    config: { GITHUB_OWNER: "SeongJinSong", SLACK_CHANNEL_PREFIX: "app-" } as Config,
    github: {
      async getRepo(r: string) {
        if (opts.missing) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { fullName: r, name: r.split("/")[1], description: "구천동벌꿀 홈페이지", defaultBranch: "main" };
      },
      async deleteRepo(r: string) {
        calls.push(`deleteRepo:${r}`);
        return true;
      },
    },
    vercel: {
      async findProjectByRepo() {
        return opts.vercel ? { id: "prj_1", name: "silverclub", productionUrl: "https://employment-center.vercel.app" } : null;
      },
      async deleteProject(id: string) {
        calls.push(`deleteProject:${id}`);
        return true;
      },
    },
    notifier: { async archiveChannel(c: string) { calls.push(`archive:${c}`); } },
  };
  return { store, calls, deps: deps as never };
}

describe("기존 레포 연결", () => {
  it("Cloudflare 등 Vercel 아닌 레포: 채널에 연결, 프로젝트 없음", async () => {
    const { store, deps } = await setup();
    const r = await connectRepo(deps, { repoArg: "mujuhoney", channelId: "C1", userId: "U1" });
    expect(r.ok).toBe(true);
    const app = store.getAppByChannel("C1")!;
    expect(app.repo).toBe("SeongJinSong/mujuhoney");
    expect(app.connected).toBe(1);
    expect(app.vercel_project_id).toBeNull();
    expect(app.status).toBe("ready");
  });

  it("Vercel 레포: 프로젝트와 운영 URL을 찾아 둔다", async () => {
    const { store, deps } = await setup({ vercel: true });
    await connectRepo(deps, { repoArg: "silverclub", channelId: "C2", userId: "U1" });
    const app = store.getAppByChannel("C2")!;
    expect(app.vercel_project_id).toBe("prj_1");
    expect(app.production_url).toBe("https://employment-center.vercel.app");
  });

  it("같은 채널/같은 레포 중복 연결, 없는 레포는 거절", async () => {
    const { deps } = await setup();
    await connectRepo(deps, { repoArg: "mujuhoney", channelId: "C1", userId: "U1" });
    const again = await connectRepo(deps, { repoArg: "silverclub", channelId: "C1", userId: "U1" });
    expect(again.ok).toBe(false);
    const dup = await connectRepo(deps, { repoArg: "SeongJinSong/mujuhoney", channelId: "C9", userId: "U1" });
    expect(dup.ok).toBe(false);
    const { deps: d2 } = await setup({ missing: true });
    const missing = await connectRepo(d2, { repoArg: "nope", channelId: "C3", userId: "U1" });
    expect(missing.ok).toBe(false);
  });

  it("연결한 레포를 /deleteapp 하면 연결만 끊고 레포·배포·채널은 그대로", async () => {
    const { store, calls, deps } = await setup({ vercel: true });
    await connectRepo(deps, { repoArg: "silverclub", channelId: "C2", userId: "U1" });
    const app = store.getAppByChannel("C2")!;
    const r = await deleteApp(deps, app.id);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(store.getApp(app.id)).toBeUndefined();
  });
});
