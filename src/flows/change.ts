import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { commitAll } from "../integrations/github.js";
import type { AppRecord, ChangeRecord } from "../store.js";
import { exec } from "../util/exec.js";
import { branchName } from "../util/names.js";
import { changeBlocks } from "../slack/blocks.js";
import type { Deps } from "./context.js";

/**
 * Slack 요구사항 1건 → 브랜치 → Claude 에이전트 코드 수정 → PR → Vercel 프리뷰 → 승인 버튼.
 * 같은 스레드에 다시 말하면 같은 브랜치/PR에 이어서 수정한다.
 */
export function requestChange(
  deps: Deps,
  app: AppRecord,
  args: { threadTs: string; userId: string; request: string },
): Promise<void> {
  return deps.queue.run(app.slug, () => runChange(deps, app, args));
}

async function runChange(
  deps: Deps,
  app: AppRecord,
  { threadTs, userId, request }: { threadTs: string; userId: string; request: string },
): Promise<void> {
  const { store, github, vercel, notifier, config } = deps;
  const channel = app.slack_channel_id;

  let change = store.getOpenChangeByThread(app.id, threadTs);
  const continuing = Boolean(change?.pr_number);
  if (!change) {
    change = store.createChange({
      app_id: app.id,
      slack_thread_ts: threadTs,
      requested_by: userId,
      request,
      branch: "pending",
    });
    const branch = branchName(change.id, request);
    store.updateChange(change.id, { branch });
    change = { ...change, branch };
  } else {
    store.updateChange(change.id, {
      status: "running",
      request: `${change.request}\n\n[추가 요청]\n${request}`,
    });
  }

  const statusTs = await notifier.post(
    channel,
    continuing ? "🛠️ 같은 PR에 이어서 수정할게요…" : "🛠️ 작업 시작할게요. 진행 상황은 이 스레드에 남길게요.",
    { threadTs },
  );

  const dir = join(config.WORKSPACE_DIR, app.slug, `change-${change.id}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    if (continuing) {
      await github.clone(app.repo, dir, change.branch);
    } else {
      await github.clone(app.repo, dir);
      await exec("git", ["checkout", "-b", change.branch], { cwd: dir });
    }

    const progress: string[] = [];
    let lastUpdate = 0;
    const result = await deps.runAgent({
      cwd: dir,
      model: config.CLAUDE_MODEL,
      maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
      runner: config.AGENT_RUNNER,
      claudeBin: config.CLAUDE_BIN,
      prompt: buildPrompt(app, change, request, continuing),
      onProgress: (line) => {
        progress.push(line);
        if (Date.now() - lastUpdate > 5000) {
          lastUpdate = Date.now();
          void notifier
            .update(channel, statusTs, `🛠️ 작업 중…\n${progress.slice(-6).join("\n")}`)
            .catch(() => undefined);
        }
      },
    });

    const cost = (change.cost_usd ?? 0) + result.costUsd;
    store.updateChange(change.id, { cost_usd: cost, summary: result.summary });

    const committed = await commitAll(dir, `${firstLine(request)}\n\nRequested in Slack by ${userId}`);
    if (!committed) {
      store.updateChange(change.id, { status: change.pr_number ? "preview" : "failed" });
      await notifier.update(channel, statusTs, `🤔 코드 변경 없이 끝났어요.\n\n${result.summary}`);
      return;
    }

    await github.push(dir, change.branch);
    let prNumber = change.pr_number;
    if (!prNumber) {
      prNumber = await github.openPr(
        app.repo,
        change.branch,
        firstLine(request).slice(0, 72),
        `Slack 요청 (<@${userId}>):\n\n> ${request.replace(/\n/g, "\n> ")}\n\n---\n${result.summary}`,
      );
      store.updateChange(change.id, { pr_number: prNumber });
    }

    await notifier.update(channel, statusTs, "⏳ 코드 수정 완료. Vercel 프리뷰 배포를 기다리는 중…");
    const sha = await github.headSha(dir);
    const preview = app.vercel_project_id ? await vercel.waitForCommit(app.vercel_project_id, sha) : null;
    const previewUrl = preview?.state === "READY" ? preview.url : null;
    store.updateChange(change.id, { status: "preview", preview_url: previewUrl });

    const prUrl = `https://github.com/${app.repo}/pull/${prNumber}`;
    const fresh = store.getChange(change.id)!;
    await notifier.update(
      channel,
      statusTs,
      result.summary,
      changeBlocks({
        change: fresh,
        summary: result.summary,
        prUrl,
        previewUrl,
        previewState: preview?.state ?? "TIMEOUT",
        costUsd: cost,
      }),
    );
  } catch (err) {
    store.updateChange(change.id, { status: "failed" });
    await notifier.update(channel, statusTs, `❌ 작업 중 오류가 났어요.\n\`\`\`${String(err).slice(0, 1500)}\`\`\``);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 승인 버튼: PR 머지 → Vercel 프로덕션 배포 확인 */
export function approveChange(deps: Deps, changeId: number, userId: string): Promise<void> {
  const change = deps.store.getChange(changeId);
  if (!change) return Promise.resolve();
  const app = deps.store.getApp(change.app_id)!;
  return deps.queue.run(app.slug, async () => {
    const { store, github, vercel, notifier } = deps;
    const current = store.getChange(changeId)!;
    if (current.status !== "preview" || !current.pr_number) {
      await notifier.post(app.slack_channel_id, "이미 처리된 요청이에요.", { threadTs: current.slack_thread_ts });
      return;
    }
    const sha = await github.mergePr(app.repo, current.pr_number);
    store.updateChange(changeId, { status: "merged" });
    const ts = await notifier.post(app.slack_channel_id, `🚀 <@${userId}> 승인 → 머지 완료. 프로덕션 배포 중…`, {
      threadTs: current.slack_thread_ts,
    });
    const prod = app.vercel_project_id ? await vercel.waitForCommit(app.vercel_project_id, sha) : null;
    const url = app.production_url ?? prod?.url;
    await notifier.update(
      app.slack_channel_id,
      ts,
      prod?.state === "READY"
        ? `✅ 프로덕션 배포 완료: ${url}`
        : `⚠️ 머지는 됐지만 배포 상태가 ${prod?.state ?? "확인 불가"}예요. Vercel 대시보드를 확인해 주세요.`,
    );
  });
}

export function rejectChange(deps: Deps, changeId: number, userId: string): Promise<void> {
  const change = deps.store.getChange(changeId);
  if (!change) return Promise.resolve();
  const app = deps.store.getApp(change.app_id)!;
  return deps.queue.run(app.slug, async () => {
    if (change.pr_number) await deps.github.closePr(app.repo, change.pr_number);
    deps.store.updateChange(changeId, { status: "closed" });
    await deps.notifier.post(app.slack_channel_id, `🗑️ <@${userId}> 님이 이 변경을 닫았어요.`, {
      threadTs: change.slack_thread_ts,
    });
  });
}

function buildPrompt(app: AppRecord, change: ChangeRecord, request: string, continuing: boolean): string {
  const spec = app.spec_json && app.spec_json !== "{}" ? `\n\n[앱 스펙]\n${app.spec_json}` : "";
  if (continuing) {
    return `이 브랜치에는 이미 아래 요청에 대한 작업이 있다:\n${change.request}\n\n이어서 다음 추가 요청을 반영해라:\n${request}${spec}`;
  }
  return `앱 "${app.name}" 에 대한 Slack 요구사항:\n${request}${spec}`;
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim() || "Slack 요청";
}
