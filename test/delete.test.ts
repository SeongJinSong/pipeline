import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { deleteApp, findApp } from "../src/flows/delete.js";
import { Store } from "../src/store.js";
import { SerialQueue } from "../src/util/serial.js";

async function setup(opts: { repoFails?: boolean } = {}) {
  const store = new Store(await mkdtemp(join(tmpdir(), "del-")));
  const app = store.createApp({ slug: "knit-counter", name: "뜨개 카운터", idea: "x", repo: "me/knit-counter", created_by: "U1" });
  store.updateApp(app.id, { slack_channel_id: "C1", vercel_project_id: "prj_1", status: "failed" });
  const calls: string[] = [];
  const deps = {
    store,
    queue: new SerialQueue(),
    config: { SLACK_CHANNEL_PREFIX: "app-" } as Config,
    github: {
      async deleteRepo(r: string) {
        if (opts.repoFails) throw Object.assign(new Error("Forbidden"), { name: "HttpError", status: 403 });
        calls.push(`repo:${r}`);
        return true;
      },
    },
    vercel: { async deleteProject(id: string) { calls.push(`vercel:${id}`); return true; } },
    notifier: { async archiveChannel(c: string) { calls.push(`archive:${c}`); } },
  };
  return { store, app, calls, deps: deps as never as Parameters<typeof deleteApp>[0] };
}

describe("deleteApp", () => {
  it("레포·Vercel 삭제, 채널 보관, 기록 삭제", async () => {
    const { store, app, calls, deps } = await setup();
    const r = await deleteApp(deps, app.id);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["repo:me/knit-counter", "vercel:prj_1", "archive:C1"]);
    expect(store.getApp(app.id)).toBeUndefined();
  });

  it("한 단계가 실패하면 나머지는 진행하고 기록은 남긴다", async () => {
    const { store, app, calls, deps } = await setup({ repoFails: true });
    const r = await deleteApp(deps, app.id);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("HttpError 403");
    expect(calls).toEqual(["vercel:prj_1", "archive:C1"]);
    expect(store.getApp(app.id)).toBeDefined();
  });

  it("슬러그·이름·채널 멘션으로 찾는다", async () => {
    const { app, deps } = await setup();
    const d = deps as never as Parameters<typeof findApp>[0];
    expect(findApp(d, "knit-counter")?.id).toBe(app.id);
    expect(findApp(d, "뜨개 카운터")?.id).toBe(app.id);
    expect(findApp(d, "#app-knit-counter")?.id).toBe(app.id);
    expect(findApp(d, "<#C1|app-knit-counter>")?.id).toBe(app.id);
    expect(findApp(d, "nope")).toBeUndefined();
  });
});
