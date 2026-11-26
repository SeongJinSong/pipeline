import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { approveChange, rejectChange, requestChange } from "../flows/change.js";
import type { Deps, Notifier } from "../flows/context.js";
import { connectRepo } from "../flows/connect.js";
import { deleteApp, findApp } from "../flows/delete.js";
import { cancelDraft, launchDraft, reviseDraft, startDraft } from "../flows/draft.js";
import { cancelConsoleOp, handleConsoleRequest, parseConsoleRequest, runConsoleOp } from "../flows/tossops.js";
import {
  ACTION_APPROVE,
  ACTION_DELETE,
  ACTION_DRAFT_CANCEL,
  ACTION_DRAFT_LAUNCH,
  ACTION_REJECT,
  ACTION_TOSS_CANCEL,
  ACTION_TOSS_RUN,
  deleteConfirmBlocks,
} from "./blocks.js";

const { App } = bolt;

export function slackNotifier(client: WebClient): Notifier {
  return {
    async post(channel, text, opts = {}) {
      const res = await client.chat.postMessage({
        channel,
        text,
        thread_ts: opts.threadTs,
        blocks: opts.blocks as never,
        unfurl_links: false,
      });
      return res.ts!;
    },
    async update(channel, ts, text, blocks) {
      await client.chat.update({ channel, ts, text, blocks: (blocks ?? []) as never });
    },
    async createChannel(name, purpose) {
      const res = await client.conversations.create({ name, is_private: false });
      const id = res.channel!.id!;
      await client.conversations.setPurpose({ channel: id, purpose }).catch(() => undefined);
      return id;
    },
    async invite(channel, userIds) {
      if (!userIds.length) return;
      await client.conversations.invite({ channel, users: userIds.join(",") }).catch((e: unknown) => {
        // already_in_channel 등은 무시
        if (!String(e).includes("already_in_channel")) throw e;
      });
    },
    async archiveChannel(channel) {
      await client.conversations.join({ channel }).catch(() => undefined);
      const info = await client.conversations.info({ channel });
      if (info.channel?.is_archived) return;
      // 같은 이름으로 새 앱을 다시 만들 수 있게 이름을 비켜준다
      const name = `${info.channel?.name ?? "app"}`.slice(0, 60);
      await client.conversations
        .rename({ channel, name: `${name}-deleted-${Date.now().toString(36)}` })
        .catch(() => undefined);
      await client.conversations.archive({ channel });
    },
    async permalink(channel, ts) {
      const res = await client.chat.getPermalink({ channel, message_ts: ts });
      return res.permalink;
    },
  };
}

export function createSlackApp(
  deps: Omit<Deps, "notifier">,
  opts: { botToken: string; appToken: string; launchChannel?: string },
) {
  const app = new App({ token: opts.botToken, appToken: opts.appToken, socketMode: true });
  const notifier = slackNotifier(app.client);
  const full: Deps = { ...deps, notifier };
  const allowed = new Set(deps.config.SLACK_ALLOWED_USERS);
  const isAllowed = (userId: string) => allowed.size === 0 || allowed.has(userId);
  // SLACK_OPEN_ACCESS=true: 워크스페이스 누구나 앱 만들기·요청·배포 가능. 레포 연결/삭제는 SLACK_ALLOWED_USERS(관리자)만.
  const canUse = (userId: string) => deps.config.SLACK_OPEN_ACCESS || isAllowed(userId);

  const fail = (where: string) => (err: unknown) => app.logger.error(`[${where}]`, err);

  // /newapp <아이디어> → 입력한 채널에 메시지를 올리고, 그 스레드에서 PRD를 같이 다듬는다
  app.command("/newapp", async ({ command, ack, respond }) => {
    await ack();
    if (!canUse(command.user_id)) {
      await respond({ response_type: "ephemeral", text: "앱을 만들 권한이 없어요. 관리자에게 SLACK_ALLOWED_USERS 추가를 요청하세요." });
      return;
    }
    const idea = command.text.trim();
    if (!idea) {
      await respond({ response_type: "ephemeral", text: "사용법: `/newapp 동네 러닝 크루 모집하는 앱`" });
      return;
    }
    const rootText = `💡 <@${command.user_id}> 새 앱 아이디어\n> ${idea.replace(/\n/g, "\n> ")}`;
    // 입력한 채널에 남긴다. 봇이 못 들어가는 곳(남의 DM 등)이면 설정된 채널이나 봇 DM으로.
    let channel = opts.launchChannel ?? command.channel_id;
    let rootTs: string;
    try {
      await app.client.conversations.join({ channel }).catch(() => undefined);
      rootTs = await notifier.post(channel, rootText);
    } catch {
      const dm = await app.client.conversations.open({ users: command.user_id });
      channel = dm.channel!.id!;
      rootTs = await notifier.post(channel, rootText);
    }
    void startDraft(full, { idea, userId: command.user_id, channel, rootTs }).catch(fail("draft"));
  });

  // /myapps → 만든 앱 목록 (/apps 는 Slack 예약어)
  app.command("/myapps", async ({ ack, respond }) => {
    await ack();
    const apps = deps.store.listApps();
    const text = apps.length
      ? apps
          .map((a) => `• *${a.name}* \`${a.slug}\` (${a.status}) ${a.slack_channel_id ? `<#${a.slack_channel_id}>` : "채널 없음"} · ${a.production_url ?? "-"} · github.com/${a.repo}`)
          .join("\n")
      : "아직 만든 앱이 없어요. `/newapp 아이디어` 로 시작하세요.";
    await respond({ response_type: "ephemeral", text });
  });

  // /connectapp <레포> → 이 채널을 이미 있는 GitHub 레포에 연결 (봇이 만들지 않은 서비스도 Slack에서 수정·배포)
  app.command("/connectapp", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond({ response_type: "ephemeral", text: "레포 연결은 관리자(SLACK_ALLOWED_USERS)만 할 수 있어요." });
      return;
    }
    if (!command.text.trim()) {
      await respond({ response_type: "ephemeral", text: "사용법: 연결할 채널에서 `/connectapp mujuhoney` 또는 `/connectapp SeongJinSong/mujuhoney`" });
      return;
    }
    await app.client.conversations.join({ channel: command.channel_id }).catch(() => undefined);
    const result = await connectRepo(deps, { repoArg: command.text, channelId: command.channel_id, userId: command.user_id });
    if (!result.ok) {
      await respond({ response_type: "ephemeral", text: result.message });
      return;
    }
    const a = result.app;
    await notifier.post(
      command.channel_id,
      [
        `🔗 <@${command.user_id}> 님이 이 채널을 \`${a.repo}\` 에 연결했어요.`,
        `• 사용법: 이 채널에서 \`@봇 요구사항\` → 코드 수정 → PR${result.vercel ? " + 프리뷰" : ""} → [🚀 배포] 버튼으로 반영`,
        `• 배포: ${result.vercel ? `Vercel (${a.production_url ?? "프로젝트 연결됨"})` : "main 머지 시 레포의 자동 배포(Cloudflare 등)로 반영"}`,
        `• 같은 스레드에서 다시 멘션하면 같은 PR에 이어서 고쳐요.`,
      ].join("\n"),
    );
  });

  // /deleteapp <앱 이름|슬러그|#채널> → 확인 버튼 → 레포·Vercel 삭제, 채널 보관
  app.command("/deleteapp", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond({ response_type: "ephemeral", text: "앱을 지울 권한이 없어요." });
      return;
    }
    const query = command.text.trim();
    const target = query ? findApp(deps, query) : deps.store.getAppByChannel(command.channel_id);
    if (!target) {
      const names = deps.store.listApps().map((a) => `\`${a.slug}\``).join(", ") || "없음";
      await respond({ response_type: "ephemeral", text: `어떤 앱인지 못 찾았어요. 사용법: \`/deleteapp knit-counter\`\n지금 있는 앱: ${names}` });
      return;
    }
    await respond({ response_type: "ephemeral", text: `${target.name} 삭제 확인`, blocks: deleteConfirmBlocks(target) as never });
  });

  app.action(ACTION_DELETE, async ({ ack, body, action, respond }) => {
    await ack();
    if (!isAllowed(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "앱을 지울 권한이 없어요." });
      return;
    }
    const appId = Number((action as { value?: string }).value);
    await respond({ replace_original: true, text: "🗑 지우는 중…" });
    try {
      const result = await deleteApp(full, appId);
      await respond({ replace_original: true, text: result.lines.join("\n") });
    } catch (err) {
      fail("delete")(err);
      await respond({ replace_original: true, text: `❌ 삭제 중 오류: ${String(err).slice(0, 500)}` });
    }
  });

  const stripMentions = (text: string) => text.replace(/<@[A-Z0-9]+>/g, "").trim();

  // 같은 PRD 스레드의 작업은 한 줄로 (동시에 두 번 고치지 않게)
  const onDraftMessage = (draftId: number, userId: string, message: string) =>
    deps.queue.run(`draft-${draftId}`, () => reviseDraft(full, draftId, { userId, message })).catch(fail("revise"));

  /**
   * @pipeline 멘션
   * - PRD 스레드 안: PRD 수정
   * - 앱 채널: 요구사항 → 코드 수정 (그 메시지 아래 스레드, 같은 스레드면 같은 PR)
   * - 그 밖의 채널: 새 아이디어 → 그 메시지 아래 스레드에서 PRD 시작
   * - 어디서든 `콘솔 …` 으로 시작하면: 앱인토스 콘솔 작업 (관리자만. 토스 계정 권한으로 콘솔을 바꾼다)
   */
  app.event("app_mention", async ({ event, client }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const user = event.user ?? "";
    const text = stripMentions(event.text);
    const reply = (t: string) => client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: t });

    if (!canUse(user)) {
      await reply("요청은 기록해 둘게요. 앱 만들기·코드 수정은 승인된 멤버만 할 수 있어요.");
      return;
    }

    const consoleRequest = parseConsoleRequest(text);
    if (consoleRequest !== null) {
      if (!isAllowed(user)) {
        await reply("앱인토스 콘솔 작업은 관리자(SLACK_ALLOWED_USERS)만 할 수 있어요.");
        return;
      }
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => undefined);
      const appRecord = deps.store.getAppByChannel(event.channel);
      void handleConsoleRequest(full, { channel: event.channel, threadTs, userId: user, request: consoleRequest, app: appRecord }).catch(
        fail("toss-console"),
      );
      return;
    }

    const draft = event.thread_ts ? deps.store.getDraftByThread(event.channel, event.thread_ts) : undefined;
    if (draft) {
      if (!text) return;
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => undefined);
      void onDraftMessage(draft.id, user, text);
      return;
    }

    const target = deps.store.getAppByChannel(event.channel);
    if (target) {
      if (!text) return;
      const name = deps.queue.pending(target.slug) ? "hourglass_flowing_sand" : "eyes";
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name }).catch(() => undefined);
      void requestChange(full, target, { threadTs, userId: user, request: text }).catch(fail("change"));
      return;
    }

    if (!text) {
      await reply("새 앱 아이디어를 같이 적어주세요. 예: `@pipeline 동네 러닝 크루 모집 앱`");
      return;
    }
    // 아이디어 → 이 메시지 아래 스레드에서 PRD 시작
    void startDraft(full, { idea: text, userId: user, channel: event.channel, rootTs: threadTs }).catch(fail("draft"));
  });

  // PRD 스레드에서는 멘션 없이 답해도 PRD를 고친다 (message.channels 이벤트 구독 필요)
  app.message(async ({ message, context }) => {
    const m = message as { subtype?: string; bot_id?: string; thread_ts?: string; ts: string; text?: string; user?: string; channel: string };
    if (m.subtype || m.bot_id || !m.thread_ts || !m.user || !m.text) return;
    if (context.botUserId && m.text.includes(`<@${context.botUserId}>`)) return; // app_mention 이 처리
    const draft = deps.store.getDraftByThread(m.channel, m.thread_ts);
    if (!draft || draft.status !== "drafting" || !canUse(m.user)) return;
    const text = stripMentions(m.text);
    if (!text) return;
    await app.client.reactions.add({ channel: m.channel, timestamp: m.ts, name: "eyes" }).catch(() => undefined);
    void onDraftMessage(draft.id, m.user, text);
  });

  app.action(ACTION_DRAFT_LAUNCH, async ({ ack, body, action, respond }) => {
    await ack();
    if (!canUse(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "출시 권한이 없어요." });
      return;
    }
    const draftId = Number((action as { value?: string }).value);
    void deps.queue.run(`draft-${draftId}`, () => launchDraft(full, draftId, body.user.id)).catch(fail("launch"));
  });

  app.action(ACTION_DRAFT_CANCEL, async ({ ack, body, action, respond }) => {
    await ack();
    if (!canUse(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "권한이 없어요." });
      return;
    }
    void cancelDraft(full, Number((action as { value?: string }).value), body.user.id).catch(fail("cancel"));
  });

  app.action(ACTION_APPROVE, async ({ ack, body, action, respond }) => {
    await ack();
    if (!canUse(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "배포 권한이 없어요." });
      return;
    }
    const changeId = Number((action as { value?: string }).value);
    void approveChange(full, changeId, body.user.id).catch(fail("approve"));
  });

  app.action(ACTION_REJECT, async ({ ack, body, action, respond }) => {
    await ack();
    if (!canUse(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "권한이 없어요." });
      return;
    }
    const changeId = Number((action as { value?: string }).value);
    void rejectChange(full, changeId, body.user.id).catch(fail("reject"));
  });

  app.action(ACTION_TOSS_RUN, async ({ ack, body, action, respond }) => {
    await ack();
    if (!isAllowed(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "앱인토스 콘솔 작업은 관리자만 실행할 수 있어요." });
      return;
    }
    await runConsoleOp(full, String((action as { value?: string }).value), body.user.id).catch(async (err: unknown) => {
      await respond({ response_type: "ephemeral", replace_original: false, text: String((err as Error).message ?? err) });
    });
  });

  app.action(ACTION_TOSS_CANCEL, async ({ ack, body, action, respond }) => {
    await ack();
    if (!isAllowed(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "권한이 없어요." });
      return;
    }
    void cancelConsoleOp(full, String((action as { value?: string }).value), body.user.id).catch(fail("toss-cancel"));
  });

  return app;
}
