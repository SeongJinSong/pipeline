import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { approveChange, rejectChange, requestChange } from "../flows/change.js";
import type { Deps, Notifier } from "../flows/context.js";
import { deleteApp, findApp } from "../flows/delete.js";
import { launchApp } from "../flows/launch.js";
import { ACTION_APPROVE, ACTION_DELETE, ACTION_REJECT, deleteConfirmBlocks } from "./blocks.js";

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

  const fail = (where: string) => (err: unknown) => app.logger.error(`[${where}]`, err);

  // /newapp <아이디어>  → 스펙 정리부터 채널 생성, 첫 배포까지
  app.command("/newapp", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond({ response_type: "ephemeral", text: "앱을 만들 권한이 없어요. 관리자에게 SLACK_ALLOWED_USERS 추가를 요청하세요." });
      return;
    }
    const idea = command.text.trim();
    if (!idea) {
      await respond({ response_type: "ephemeral", text: "사용법: `/newapp 동네 러닝 크루 모집하는 앱`" });
      return;
    }
    let origin = opts.launchChannel;
    if (!origin) {
      const dm = await app.client.conversations.open({ users: command.user_id });
      origin = dm.channel!.id!;
    }
    await respond({ response_type: "ephemeral", text: `접수했어요! 진행 상황은 <#${origin}> 에 남길게요.` });
    void launchApp(full, { idea, userId: command.user_id, originChannel: origin }).catch(fail("launch"));
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

  // 앱 채널에서 @봇 멘션 = 요구사항. 같은 스레드에서 다시 멘션하면 같은 PR에 이어서 수정.
  app.event("app_mention", async ({ event, client }) => {
    const target = deps.store.getAppByChannel(event.channel);
    const threadTs = event.thread_ts ?? event.ts;
    const user = event.user ?? "";
    if (!target) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "여기는 앱 채널이 아니에요. 새 앱은 `/newapp 아이디어` 로 만들 수 있어요.",
      });
      return;
    }
    if (!isAllowed(user)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "요구사항은 기록해 둘게요. 코드 수정은 승인된 멤버만 요청할 수 있어요.",
      });
      return;
    }
    const request = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!request) return;
    if (deps.queue.pending(target.slug)) {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "hourglass_flowing_sand" }).catch(() => undefined);
    } else {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => undefined);
    }
    void requestChange(full, target, { threadTs, userId: user, request }).catch(fail("change"));
  });

  app.action(ACTION_APPROVE, async ({ ack, body, action, respond }) => {
    await ack();
    if (!isAllowed(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "배포 권한이 없어요." });
      return;
    }
    const changeId = Number((action as { value?: string }).value);
    void approveChange(full, changeId, body.user.id).catch(fail("approve"));
  });

  app.action(ACTION_REJECT, async ({ ack, body, action, respond }) => {
    await ack();
    if (!isAllowed(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "권한이 없어요." });
      return;
    }
    const changeId = Number((action as { value?: string }).value);
    void rejectChange(full, changeId, body.user.id).catch(fail("reject"));
  });

  return app;
}
