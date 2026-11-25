import { AppSpecSchema, type AppSpec, type SpecTurn } from "../integrations/claude.js";
import { draftBlocks } from "../slack/blocks.js";
import type { DraftRecord } from "../store.js";
import { describeError } from "../util/errors.js";
import type { Deps } from "./context.js";
import { launchApp } from "./launch.js";

/**
 * 아이디어 하나 = Slack 스레드 하나.
 * 스레드에 PRD(스펙)를 올리고, 같은 스레드의 대화로 PRD를 고친 뒤, [🚀 출시] 버튼으로 레포·채널·배포까지 간다.
 * 대화는 DB(drafts.history_json)에 쌓아 매번 Claude에 넘기므로 맥락이 유지되고, 출시하면 SPEC.md 에도 남는다.
 */

const MAX_HISTORY = 30;

export const draftSpec = (d: DraftRecord): AppSpec => AppSpecSchema.parse(JSON.parse(d.spec_json));
export const draftHistory = (d: DraftRecord): SpecTurn[] => JSON.parse(d.history_json) as SpecTurn[];

/** rootTs: 스레드를 달 메시지 (/newapp 이 올린 메시지 또는 @pipeline 멘션 메시지) */
export async function startDraft(
  deps: Deps,
  args: { idea: string; userId: string; channel: string; rootTs: string },
): Promise<DraftRecord> {
  const { store, claude, notifier } = deps;
  const draft = store.createDraft({ channel_id: args.channel, thread_ts: args.rootTs, idea: args.idea, created_by: args.userId });
  const status = await notifier.post(args.channel, "📝 PRD 정리 중… (1~2분)", { threadTs: args.rootTs });
  try {
    const spec = await claude.ideaToSpec(args.idea);
    store.updateDraft(draft.id, { spec_json: JSON.stringify(spec) });
    await notifier.update(args.channel, status, `📋 ${spec.name} PRD 초안`, draftBlocks(spec, draft.id, { version: 1 }));
  } catch (err) {
    console.error(err);
    store.updateDraft(draft.id, { status: "cancelled" });
    await notifier.update(args.channel, status, `❌ PRD 정리 중 오류: \`\`\`${describeError(err).slice(0, 1500)}\`\`\``);
  }
  return store.getDraft(draft.id)!;
}

/** 스레드 대화로 PRD 수정 */
export async function reviseDraft(deps: Deps, draftId: number, args: { userId: string; message: string }): Promise<void> {
  const { store, claude, notifier } = deps;
  const draft = store.getDraft(draftId);
  if (!draft) return;
  if (draft.status !== "drafting") {
    await notifier.post(draft.channel_id, statusNote(draft), { threadTs: draft.thread_ts });
    return;
  }
  const status = await notifier.post(draft.channel_id, "✏️ PRD 반영 중…", { threadTs: draft.thread_ts });
  try {
    const history = draftHistory(draft);
    const revision = await claude.reviseSpec(draft.idea, draftSpec(draft), history, args.message);
    const next: SpecTurn[] = [
      ...history,
      { role: "user" as const, text: args.message },
      { role: "assistant" as const, text: revision.reply },
    ].slice(-MAX_HISTORY);
    // 그 사이 출시 버튼이 눌렸으면 덮어쓰지 않는다
    if (store.getDraft(draftId)?.status !== "drafting") return;
    store.updateDraft(draftId, { spec_json: JSON.stringify(revision.spec), history_json: JSON.stringify(next) });
    const version = next.filter((t) => t.role === "assistant").length + 1;
    await notifier.update(
      draft.channel_id,
      status,
      revision.reply,
      draftBlocks(revision.spec, draftId, { version, reply: revision.reply }),
    );
  } catch (err) {
    console.error(err);
    await notifier.update(draft.channel_id, status, `❌ PRD 수정 중 오류: \`\`\`${describeError(err).slice(0, 1500)}\`\`\``);
  }
}

/** [🚀 출시] → 지금 PRD로 레포·채널·Vercel·첫 구현까지. 진행 상황은 같은 스레드에. */
export async function launchDraft(deps: Deps, draftId: number, userId: string): Promise<void> {
  const { store, notifier } = deps;
  const draft = store.getDraft(draftId);
  if (!draft) return;
  if (draft.status !== "drafting") {
    await notifier.post(draft.channel_id, statusNote(draft), { threadTs: draft.thread_ts });
    return;
  }
  store.updateDraft(draftId, { status: "launching" });
  await notifier.post(draft.channel_id, `🚀 <@${userId}> 님이 이 PRD로 출시를 시작했어요.`, { threadTs: draft.thread_ts });
  const appId = await launchApp(deps, {
    idea: draft.idea,
    userId,
    originChannel: draft.channel_id,
    threadTs: draft.thread_ts,
    spec: draftSpec(draft),
    history: draftHistory(draft),
  });
  const app = appId ? store.getApp(appId) : undefined;
  if (app && app.status !== "failed") {
    store.updateDraft(draftId, { status: "launched", app_id: app.id });
  } else {
    // 실패하면 다시 출시할 수 있게 되돌린다 (/deleteapp 으로 남은 것 정리 후)
    store.updateDraft(draftId, { status: "drafting", app_id: null });
  }
}

export async function cancelDraft(deps: Deps, draftId: number, userId: string): Promise<void> {
  const draft = deps.store.getDraft(draftId);
  if (!draft || draft.status !== "drafting") return;
  deps.store.updateDraft(draftId, { status: "cancelled" });
  await deps.notifier.post(draft.channel_id, `🛑 <@${userId}> 님이 이 아이디어를 접었어요.`, { threadTs: draft.thread_ts });
}

function statusNote(d: DraftRecord): string {
  switch (d.status) {
    case "launching":
      return "지금 출시 중이라 PRD를 바꿀 수 없어요.";
    case "launched":
      return d.app_id ? "이미 출시된 앱이에요. 수정은 앱 채널에서 @pipeline 으로 요청해주세요." : "이미 출시됐어요.";
    case "cancelled":
      return "접은 아이디어예요. 다시 하려면 `/newapp` 으로 새로 시작해주세요.";
    default:
      return "";
  }
}
