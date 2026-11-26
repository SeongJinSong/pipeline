import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { commitAll } from "../integrations/github.js";
import type { AppRecord, ChangeRecord } from "../store.js";
import { exec } from "../util/exec.js";
import { branchName } from "../util/names.js";
import { changeBlocks } from "../slack/blocks.js";
import type { Deps } from "./context.js";
import { describeError } from "../util/errors.js";
import { uploadTossBundle } from "./toss.js";
import { addToBoard, openRequestIssue, planPrompt, prBody, preparePlanDoc, recordAgentSummary } from "./tracking.js";

/**
 * Slack 요구사항 1건 → GitHub 이슈 → 브랜치 + 계획 문서(docs/plans) → Claude 에이전트 코드 수정
 * → PR(Closes #이슈) → Vercel 프리뷰 → 승인 버튼.
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

  // 요청을 이슈로 남긴다 (처음 한 번). 이어서 온 요청은 이슈에 댓글로 덧붙인다
  const slackLink = await notifier.permalink?.(channel, threadTs).catch(() => undefined);
  if (!change.issue_number) {
    const issue = await openRequestIssue(deps, app, { request: change.request, userId, slackLink });
    if (issue) {
      store.updateChange(change.id, { issue_number: issue });
      change = { ...change, issue_number: issue };
    }
  } else if (change.request !== request) {
    await github
      .commentIssue(app.repo, change.issue_number, `Slack 추가 요청 (\`${userId}\`):\n\n> ${request.replace(/\n/g, "\n> ")}`)
      .catch(() => undefined);
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

    const plan = await preparePlanDoc(dir, { app, change, request, userId, slackLink: slackLink ?? undefined });

    const progress: string[] = [];
    let lastUpdate = 0;
    const result = await deps.runAgent({
      cwd: dir,
      model: config.CLAUDE_MODEL,
      maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
      runner: config.AGENT_RUNNER,
      claudeBin: config.CLAUDE_BIN,
      prompt: buildPrompt(app, change, request, continuing) + planPrompt(plan),
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

    await recordAgentSummary(dir, plan, result.summary);
    // 계획 문서만 바뀌었으면(= 에이전트가 코드를 안 고침) 커밋하지 않는다
    const changedPaths = (await exec("git", ["status", "--porcelain", "-uall"], { cwd: dir })).stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
    const refs = change.issue_number ? `\n\nRefs #${change.issue_number}` : "";
    const committed =
      changedPaths.some((p) => p !== plan) &&
      (await commitAll(dir, `${firstLine(request)}\n\nRequested in Slack by ${userId}${refs}`));
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
        prBody({
          repo: app.repo,
          branch: change.branch,
          issue: change.issue_number,
          plan,
          userId,
          request,
          summary: result.summary,
        }),
      );
      store.updateChange(change.id, { pr_number: prNumber });
      await addToBoard(deps, app, prNumber, "In Progress");
    }

    if (app.vercel_project_id) {
      await notifier.update(channel, statusTs, "⏳ 코드 수정 완료. Vercel 프리뷰 배포를 기다리는 중…");
    }
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
        previewState: app.vercel_project_id ? (preview?.state ?? "TIMEOUT") : "NONE",
        costUsd: cost,
      }),
    );

    // 앱인토스 미니앱이면 이 브랜치 번들을 테스트용으로 올려 토스 앱 테스트 링크를 남긴다 (출시는 아님)
    const toss = await uploadTossBundle(deps, app, dir, {
      stage: "preview",
      memo: `PR #${prNumber} ${firstLine(request).slice(0, 80)} (${sha.slice(0, 7)})`,
    });
    if (toss) await notifier.post(channel, toss, { threadTs });
  } catch (err) {
    console.error(err);
    store.updateChange(change.id, { status: "failed" });
    await notifier.update(channel, statusTs, `❌ 작업 중 오류가 났어요.\n\`\`\`${describeError(err).slice(0, 1500)}\`\`\``);
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
    let sha: string;
    try {
      sha = await github.mergePr(app.repo, current.pr_number);
    } catch (err) {
      // 충돌·필수 체크 실패 등: 머지하지 않고 프리뷰 상태 유지
      console.error(err);
      await notifier.post(
        app.slack_channel_id,
        `⚠️ 머지하지 못했어요. 운영에는 반영되지 않았어요.\n\`\`\`${describeError(err).slice(0, 800)}\`\`\`\n이 스레드에서 \`@봇 충돌 해결해줘\` 처럼 요청하면 이어서 고쳐요.`,
        { threadTs: current.slack_thread_ts },
      );
      return;
    }
    store.updateChange(changeId, { status: "merged" });
    const ts = await notifier.post(app.slack_channel_id, `🚀 <@${userId}> 승인 → 머지 완료. 프로덕션 배포 중…`, {
      threadTs: current.slack_thread_ts,
    });
    if (!app.vercel_project_id) {
      await notifier.update(
        app.slack_channel_id,
        ts,
        `✅ \`${app.repo}\` 기본 브랜치에 머지했어요. 이 레포의 자동 배포(Cloudflare 등)로 몇 분 안에 반영돼요.${app.production_url ? ` ${app.production_url}` : ""}`,
      );
    } else {
      const prod = await vercel.waitForCommit(app.vercel_project_id, sha);
      const url = app.production_url ?? prod?.url;
      await notifier.update(
        app.slack_channel_id,
        ts,
        prod?.state === "READY"
          ? `✅ 프로덕션 배포 완료: ${url}`
          : `⚠️ 머지는 됐지만 배포 상태가 ${prod?.state ?? "확인 불가"}예요. Vercel 대시보드를 확인해 주세요.`,
      );
    }
    await releaseTossBundle(deps, app, current, sha);
  });
}

/** 머지된 기본 브랜치가 앱인토스 미니앱이면 번들을 올린다. 사용자 공개(출시)는 콘솔에서 사람이 한다 */
async function releaseTossBundle(deps: Deps, app: AppRecord, change: ChangeRecord, sha: string): Promise<void> {
  if (!deps.toss) return;
  const dir = join(deps.config.WORKSPACE_DIR, app.slug, `release-${change.id}-${Date.now()}`);
  try {
    await mkdir(dir, { recursive: true });
    await deps.github.clone(app.repo, dir);
    const toss = await uploadTossBundle(deps, app, dir, {
      stage: "release",
      memo: `main ${sha.slice(0, 7)} · PR #${change.pr_number} ${firstLine(change.request).slice(0, 80)}`,
    });
    if (toss) await deps.notifier.post(app.slack_channel_id, toss, { threadTs: change.slack_thread_ts });
  } catch (err) {
    console.error(err);
    await deps.notifier.post(
      app.slack_channel_id,
      `⚠️ 앱인토스 번들을 준비하지 못했어요.\n\`\`\`${describeError(err).slice(0, 800)}\`\`\``,
      { threadTs: change.slack_thread_ts },
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function rejectChange(deps: Deps, changeId: number, userId: string): Promise<void> {
  const change = deps.store.getChange(changeId);
  if (!change) return Promise.resolve();
  const app = deps.store.getApp(change.app_id)!;
  return deps.queue.run(app.slug, async () => {
    if (change.pr_number) await deps.github.closePr(app.repo, change.pr_number);
    if (change.issue_number) {
      await deps.github.closeIssue(app.repo, change.issue_number, "not_planned").catch(() => undefined);
    }
    deps.store.updateChange(changeId, { status: "closed" });
    await deps.notifier.post(app.slack_channel_id, `🗑️ <@${userId}> 님이 이 변경을 닫았어요.`, {
      threadTs: change.slack_thread_ts,
    });
  });
}

function buildPrompt(app: AppRecord, change: ChangeRecord, request: string, continuing: boolean): string {
  const spec = app.spec_json && app.spec_json !== "{}" ? `\n\n[앱 스펙]\n${app.spec_json}` : "";
  const intro = app.connected
    ? `운영 중인 기존 서비스 "${app.name}" (${app.repo}) 레포다. CLAUDE.md·AGENTS.md 등 레포 규칙을 먼저 읽고 따르고, package.json 의 검사(check/test/build)를 통과시켜라. 머지하면 바로 운영에 배포된다.\n\n`
    : "";
  if (continuing) {
    return `${intro}이 브랜치에는 이미 아래 요청에 대한 작업이 있다:\n${change.request}\n\n이어서 다음 추가 요청을 반영해라:\n${request}${spec}`;
  }
  return `${intro}앱 "${app.name}" 에 대한 Slack 요구사항:\n${request}${spec}`;
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim() || "Slack 요청";
}
