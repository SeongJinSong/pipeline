import { describe, expect, it } from "vitest";
import type { Deps, Notifier } from "../src/flows/context.js";
import { askBeforeDraft, confirmIdea, declineIdea } from "../src/flows/intent.js";

function fakeDeps() {
  const posts: Array<{ text: string; threadTs?: string; blocks?: unknown[] }> = [];
  const drafts: string[] = [];
  let n = 0;
  const notifier: Notifier = {
    async post(_c, text, opts = {}) {
      posts.push({ text, ...opts });
      return `ts-${++n}`;
    },
    async update(_c, ts, text, blocks) {
      posts.push({ text: `[update ${ts}] ${text}`, blocks });
    },
    async createChannel() {
      return "C";
    },
    async invite() {},
    async archiveChannel() {},
  };
  const store = {
    createDraft: (d: { idea: string }) => {
      drafts.push(d.idea);
      return { id: 1, ...d };
    },
    updateDraft: () => undefined,
    getDraft: () => ({ id: 1 }),
  };
  const claude = { ideaToSpec: async () => { throw new Error("stop here"); } };
  const deps = { notifier, store, claude } as unknown as Deps;
  return { deps, posts, drafts };
}

const valueOf = (blocks: unknown[] | undefined) => JSON.stringify(blocks).match(/"value":"([^"]+)"/)![1];

describe("askBeforeDraft", () => {
  it("멘션만으로는 PRD 를 만들지 않고 먼저 묻는다", async () => {
    const { deps, posts, drafts } = fakeDeps();
    await askBeforeDraft(deps, { idea: "토스 콘솔 앱 상태 알려줘", userId: "U1", channel: "C1", threadTs: "t1" });
    expect(drafts).toEqual([]);
    expect(posts[0].threadTs).toBe("t1");
    expect(JSON.stringify(posts[0].blocks)).toContain("idea_confirm");
    expect(posts.some((p) => p.text.includes("PRD 정리 중"))).toBe(false);
  });

  it("[PRD 만들기]를 누르면 그 스레드에서 PRD 를 시작한다 (한 번만)", async () => {
    const { deps, posts, drafts } = fakeDeps();
    await askBeforeDraft(deps, { idea: "동네 러닝 크루 앱", userId: "U1", channel: "C1", threadTs: "t1" });
    const id = valueOf(posts[0].blocks);
    await confirmIdea(deps, id, "U1");
    expect(drafts).toEqual(["동네 러닝 크루 앱"]);
    expect(posts.some((p) => p.text.includes("PRD 정리 중") && p.threadTs === "t1")).toBe(true);
    await expect(confirmIdea(deps, id, "U1")).rejects.toThrow(/만료/);
  });

  it("[아니요]면 PRD 를 만들지 않고 다른 방법을 알려 준다", async () => {
    const { deps, posts, drafts } = fakeDeps();
    await askBeforeDraft(deps, { idea: "서버 설정 봐줘", userId: "U1", channel: "C1", threadTs: "t1" });
    const id = valueOf(posts[0].blocks);
    await declineIdea(deps, id);
    expect(drafts).toEqual([]);
    expect(posts.at(-1)!.text).toContain("PRD는 만들지 않을게요");
  });
});
