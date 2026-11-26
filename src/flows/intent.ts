import { randomUUID } from "node:crypto";
import { ideaConfirmBlocks } from "../slack/blocks.js";
import type { Deps } from "./context.js";
import { startDraft } from "./draft.js";

/**
 * 앱 채널·PRD 스레드 밖에서 @pipeline 을 부르면 바로 PRD 를 만들지 않고 먼저 묻는다.
 * (서버·콘솔 확인 같은 다른 요청이 PRD 로 빠지는 일을 막는다. /newapp 은 명시적이라 바로 시작한다.)
 * 답을 기다리는 아이디어는 메모리에만 둔다 (봇이 재시작되면 버튼이 만료된다).
 */

interface PendingIdea {
  idea: string;
  userId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  createdAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const pending = new Map<string, PendingIdea>();

export async function askBeforeDraft(
  deps: Deps,
  args: { idea: string; userId: string; channel: string; threadTs: string },
): Promise<void> {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.createdAt > TTL_MS) pending.delete(id);
  const id = randomUUID();
  const messageTs = await deps.notifier.post(args.channel, "새 앱 PRD를 만들까요?", {
    threadTs: args.threadTs,
    blocks: ideaConfirmBlocks(id, args.idea, { console: Boolean(deps.tossConsole?.enabled) }),
  });
  pending.set(id, { ...args, messageTs, createdAt: now });
}

/** [PRD 만들기] */
export async function confirmIdea(deps: Deps, id: string, userId: string): Promise<void> {
  const p = takePending(id);
  if (!p) throw new Error("이 확인은 만료됐어요. 다시 멘션해 주세요.");
  await deps.notifier.update(p.channel, p.messageTs, `📝 <@${userId}> 님이 PRD 만들기를 골랐어요.`);
  await startDraft(deps, { idea: p.idea, userId: p.userId, channel: p.channel, rootTs: p.threadTs });
}

/** [아니요] */
export async function declineIdea(deps: Deps, id: string): Promise<void> {
  const p = takePending(id);
  if (!p) return;
  await deps.notifier.update(
    p.channel,
    p.messageTs,
    "알겠어요, PRD는 만들지 않을게요. 원하는 걸 조금 더 구체적으로 말해 주세요. 새 앱이면 `/newapp 아이디어`, 앱인토스 콘솔 확인이면 `@pipeline 콘솔 …`, 만든 앱 목록은 `/myapps` 예요.",
  );
}

function takePending(id: string): PendingIdea | undefined {
  const p = pending.get(id);
  pending.delete(id);
  if (!p || Date.now() - p.createdAt > TTL_MS) return undefined;
  return p;
}
