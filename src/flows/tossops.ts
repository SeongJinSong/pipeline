import { randomUUID } from "node:crypto";
import { APPS_IN_TOSS_CONSOLE_URL } from "../integrations/appsintoss.js";
import type { ConsoleAction } from "../integrations/tossconsole.js";
import { tossOpBlocks } from "../slack/blocks.js";
import { describeError } from "../util/errors.js";
import type { AppRecord } from "../store.js";
import type { Deps } from "./context.js";

/**
 * Slack `@파피 콘솔 …` → 앱인토스 콘솔 MCP 작업.
 * 조회는 바로 답하고, 바뀌는 작업은 계획을 보여 준 뒤 [실행] 버튼을 눌러야 한다.
 * 확인 대기 중인 작업은 메모리에만 둔다 (봇이 재시작되면 버튼이 만료된다).
 */

export interface TossOp {
  id: string;
  channel: string;
  threadTs: string;
  userId: string;
  request: string;
  context: string;
  actions: ConsoleAction[];
  status: "pending" | "running" | "done" | "cancelled";
  messageTs: string;
  createdAt: number;
}

const OP_TTL_MS = 24 * 60 * 60 * 1000;
const ops = new Map<string, TossOp>();
const QUEUE_KEY = "toss-console";

/** `콘솔 …`, `토스 콘솔 …`, `앱인토스 콘솔 …`, `toss console …` 이면 나머지 요청을, 아니면 null */
export function parseConsoleRequest(text: string): string | null {
  const m = text.trim().match(/^(?:(?:앱인토스|토스|toss)\s*)?(?:콘솔|console)(?:[\s:,]+([\s\S]*))?$/i);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

function contextFor(app: AppRecord | undefined): string {
  const lines = [`앱인토스 콘솔: ${APPS_IN_TOSS_CONSOLE_URL}`];
  if (app) {
    lines.push(
      `이 Slack 채널은 앱 "${app.name}" 의 채널이다. 요청에 앱 이름이 없으면 이 앱을 말한다.`,
      `이 앱의 appName 은 보통 \`${app.slug}\` 이다 (레포 apps-in-toss.config 의 appName). 콘솔 목록에서 맞는 앱을 확인한다.`,
    );
  }
  return lines.join("\n");
}

export async function handleConsoleRequest(
  deps: Deps,
  args: { channel: string; threadTs: string; userId: string; request: string; app?: AppRecord },
): Promise<void> {
  const { channel, threadTs } = args;
  const console_ = deps.tossConsole;
  if (!console_?.enabled) {
    await deps.notifier.post(
      channel,
      "앱인토스 콘솔 MCP 가 봇 서버에서 꺼져 있어요. pipeline deploy/README 의 '앱인토스 콘솔 MCP' 를 따라 등록·로그인한 뒤 `TOSS_CONSOLE_MCP=true` 로 켜 주세요.",
      { threadTs },
    );
    return;
  }
  if (!args.request) {
    await deps.notifier.post(
      channel,
      "예: `@파피 콘솔 앱 상태 알려줘`, `@파피 콘솔 카페인 아웃 최신 번들 검토 요청해줘`, `@파피 콘솔 프리랜서 세금 반려 사유 알려줘`",
      { threadTs },
    );
    return;
  }
  const ts = await deps.notifier.post(channel, "🔎 앱인토스 콘솔을 확인하고 있어요…", { threadTs });
  const context = contextFor(args.app);
  await deps.queue.run(QUEUE_KEY, async () => {
    try {
      const plan = await console_.plan(args.request, context);
      if (!plan.actions.length) {
        await deps.notifier.update(channel, ts, plan.answer || "확인했어요.", [
          { type: "section", text: { type: "mrkdwn", text: (plan.answer || "확인했어요.").slice(0, 2900) } },
        ]);
        return;
      }
      prune();
      const op: TossOp = {
        id: randomUUID(),
        channel,
        threadTs,
        userId: args.userId,
        request: args.request,
        context,
        actions: plan.actions,
        status: "pending",
        messageTs: ts,
        createdAt: Date.now(),
      };
      ops.set(op.id, op);
      await deps.notifier.update(channel, ts, "앱인토스 콘솔 작업 확인", tossOpBlocks(op.id, plan.answer, plan.actions));
    } catch (err) {
      console.error(err);
      await deps.notifier.update(channel, ts, `⚠️ 앱인토스 콘솔 확인에 실패했어요.\n\`\`\`${describeError(err).slice(0, 1200)}\`\`\``);
    }
  });
}

export async function runConsoleOp(deps: Deps, opId: string, userId: string): Promise<void> {
  const op = ops.get(opId);
  if (!op || Date.now() - op.createdAt > OP_TTL_MS) {
    throw new Error("이 확인 요청은 만료됐어요. 다시 요청해 주세요.");
  }
  if (op.status !== "pending") return; // 두 번 눌러도 한 번만
  op.status = "running";
  const list = op.actions.map((a) => `• \`${a.tool}\` ${a.summary}`).join("\n");
  await deps.notifier.update(op.channel, op.messageTs, `⏳ <@${userId}> 님이 실행을 눌렀어요. 진행 중…\n${list}`);
  await deps.queue.run(QUEUE_KEY, async () => {
    try {
      const summary = await deps.tossConsole!.execute(op.request, op.context, op.actions);
      op.status = "done";
      await deps.notifier.update(op.channel, op.messageTs, `✅ <@${userId}> 님이 실행했어요.\n${list}`);
      await deps.notifier.post(op.channel, summary || "실행했어요.", { threadTs: op.threadTs });
    } catch (err) {
      op.status = "done";
      console.error(err);
      await deps.notifier.update(op.channel, op.messageTs, `⚠️ 실행 중 문제가 생겼어요.\n${list}`);
      await deps.notifier.post(op.channel, `\`\`\`${describeError(err).slice(0, 1200)}\`\`\``, { threadTs: op.threadTs });
    }
  });
}

export async function cancelConsoleOp(deps: Deps, opId: string, userId: string): Promise<void> {
  const op = ops.get(opId);
  if (!op || op.status !== "pending") return;
  op.status = "cancelled";
  ops.delete(opId);
  await deps.notifier.update(op.channel, op.messageTs, `✋ <@${userId}> 님이 취소했어요. 콘솔은 바뀌지 않았어요.`);
}

function prune(): void {
  const now = Date.now();
  for (const [id, op] of ops) if (now - op.createdAt > OP_TTL_MS) ops.delete(id);
}

/** 테스트용 */
export function _pendingOps(): Map<string, TossOp> {
  return ops;
}
