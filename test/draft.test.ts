import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Deps, Notifier } from "../src/flows/context.js";
import { cancelDraft, draftHistory, draftSpec, reviseDraft, startDraft } from "../src/flows/draft.js";
import type { AppSpec, SpecTurn } from "../src/integrations/claude.js";
import { specMarkdown } from "../src/flows/launch.js";
import { Store } from "../src/store.js";
import { SerialQueue } from "../src/util/serial.js";

const base: AppSpec = {
  name: "뜨개 카운터",
  slug: "knit-counter",
  one_liner: "단수 세기",
  target_users: "뜨개인",
  core_features: ["단수 카운트"],
  pages: [{ path: "/", purpose: "카운터" }],
  needs_backend: false,
  data_model: [],
  open_questions: ["로그인이 필요할까?"],
};

async function setup() {
  const store = new Store(await mkdtemp(join(tmpdir(), "draft-")));
  const posts: Array<{ channel: string; text: string; threadTs?: string; blocks?: unknown[] }> = [];
  const seen: Array<{ history: SpecTurn[]; message: string }> = [];
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
  const claude = {
    async ideaToSpec() {
      return base;
    },
    async reviseSpec(_idea: string, spec: AppSpec, history: SpecTurn[], message: string) {
      seen.push({ history: [...history], message });
      return {
        reply: `반영했어요: ${message}`,
        spec: { ...spec, core_features: [...spec.core_features, message], open_questions: [] },
      };
    },
  };
  const deps = { store, notifier, claude, queue: new SerialQueue() } as unknown as Deps;
  return { store, posts, seen, deps };
}

describe("PRD 스레드", () => {
  it("아이디어 → 스레드에 PRD 카드 (출시/접기 버튼)", async () => {
    const { posts, deps } = await setup();
    const d = await startDraft(deps, { idea: "뜨개질 단수 세는 앱", userId: "U1", channel: "C1", rootTs: "100.1" });
    expect(d.status).toBe("drafting");
    expect(draftSpec(d).slug).toBe("knit-counter");
    expect(posts.every((p) => p.channel === "C1")).toBe(true);
    expect(posts[0].threadTs).toBe("100.1");
    const card = JSON.stringify(posts.at(-1)!.blocks);
    expect(card).toContain("draft_launch");
    expect(card).toContain("PRD v1");
  });

  it("스레드 대화로 고치고, 이전 대화를 다음 수정에 넘긴다 (맥락 유지)", async () => {
    const { store, seen, posts, deps } = await setup();
    const d = await startDraft(deps, { idea: "x", userId: "U1", channel: "C1", rootTs: "100.1" });
    await reviseDraft(deps, d.id, { userId: "U1", message: "목표 단수 알림 추가" });
    await reviseDraft(deps, d.id, { userId: "U2", message: "다크모드도" });
    expect(seen[0].history).toEqual([]);
    expect(seen[1].history.map((t) => t.text)).toEqual(["목표 단수 알림 추가", "반영했어요: 목표 단수 알림 추가"]);
    const fresh = store.getDraft(d.id)!;
    expect(draftSpec(fresh).core_features).toEqual(["단수 카운트", "목표 단수 알림 추가", "다크모드도"]);
    expect(draftHistory(fresh)).toHaveLength(4);
    expect(JSON.stringify(posts.at(-1)!.blocks)).toContain("PRD v3");
  });

  it("접은 PRD는 더 고치지 않는다", async () => {
    const { seen, posts, deps } = await setup();
    const d = await startDraft(deps, { idea: "x", userId: "U1", channel: "C1", rootTs: "100.1" });
    await cancelDraft(deps, d.id, "U1");
    await reviseDraft(deps, d.id, { userId: "U1", message: "기능 추가" });
    expect(seen).toHaveLength(0);
    expect(posts.at(-1)!.text).toContain("접은 아이디어");
  });

  it("SPEC.md 에 PRD 대화 기록을 남긴다", () => {
    const md = specMarkdown(base, "아이디어", [
      { role: "user", text: "로그인 없이" },
      { role: "assistant", text: "로그인 뺐어요" },
    ]);
    expect(md).toContain("## PRD 대화 기록");
    expect(md).toContain("**사람**: 로그인 없이");
  });
});
