import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewFinding, ReviewResult } from "../integrations/codex.js";
import type { AppRecord, ChangeRecord, ReviewRecord } from "../store.js";
import { describeError } from "../util/errors.js";
import { exec } from "../util/exec.js";
import { requestChange } from "./change.js";
import type { Deps } from "./context.js";

/**
 * 리뷰어 페르소나 흐름.
 *
 *   파피가 PR 에 push ──▶ 리뷰어(Codex, 읽기 전용)가 같은 Slack 스레드에 리뷰 + PR 댓글
 *        ▲                         │ changes_requested 이고 왕복 횟수가 남았으면
 *        └──── 파피가 반영해 push ◀─┘ (같은 스레드에 진행 상황 + PR 댓글)
 *
 * 봇끼리 Slack 이벤트로 대화하지 않는다. 두 페르소나가 같은 프로세스에 있어서 여기서 직접 순서를 정한다.
 * Slack 은 봇 메시지를 서로 다시 이벤트로 넘기지 않으므로 무한 루프가 생기지 않고, 왕복은 REVIEW_MAX_ROUNDS 로 막는다.
 * 머지는 여전히 사람이 [배포] 버튼으로 한다.
 */

/** 리뷰어가 요청한 수정이라는 표시 (Slack Member ID 자리에 들어간다) */
export const REVIEWER_ACTOR = "reviewer";

const MAX_DIFF_CHARS = 80_000;

export function reviewEnabled(deps: Pick<Deps, "runReview" | "reviewerNotifier">): boolean {
  return Boolean(deps.runReview && deps.reviewerNotifier);
}

/**
 * 리뷰를 앱 작업 줄(queue) 뒤에 세운다. 파피 작업이 끝난 뒤에 돈다.
 * manual: 사람이 `@리뷰어` 로 부름 → 왕복 횟수를 처음부터 센다.
 */
export function scheduleReview(
  deps: Deps,
  app: AppRecord,
  changeId: number,
  opts: { manual?: boolean; focus?: string } = {},
): Promise<void> {
  return deps.queue.run(app.slug, () => runReview(deps, app, changeId, opts));
}

async function runReview(
  deps: Deps,
  app: AppRecord,
  changeId: number,
  { manual, focus }: { manual?: boolean; focus?: string },
): Promise<void> {
  const { store, github, config } = deps;
  const rv = deps.reviewerNotifier;
  const run = deps.runReview;
  if (!rv || !run) return;
  const change = store.getChange(changeId);
  if (!change) return;
  const channel = app.slack_channel_id;
  const threadTs = change.slack_thread_ts;
  if (!change.pr_number || change.status !== "preview") {
    if (manual) await rv.post(channel, "아직 리뷰할 PR이 없어요. 파피가 PR을 올리면 볼게요.", { threadTs });
    return;
  }

  const round = (manual ? 0 : change.review_rounds) + 1;
  store.updateChange(change.id, { review_rounds: round });
  const pr = change.pr_number;
  const statusTs = await rv.post(channel, `🔍 PR #${pr} 리뷰하고 있어요… (${round}차)`, { threadTs });

  const dir = join(config.WORKSPACE_DIR, app.slug, `review-${change.id}-${Date.now()}`);
  try {
    await mkdir(dir, { recursive: true });
    await github.clone(app.repo, dir, change.branch);
    const base = await defaultBranch(dir);
    await exec("git", ["fetch", "--depth", "50", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], {
      cwd: dir,
      allowFail: true,
    });
    // 클론 주소에 든 GitHub 토큰을 지운다: 리뷰어(Codex)는 .git/config 를 읽을 수 있다
    await exec("git", ["remote", "set-url", "origin", `https://github.com/${app.repo}.git`], { cwd: dir });
    const diff = await prDiff(dir, base);
    const headSha = await github.headSha(dir);

    const result = await run({
      cwd: dir,
      prompt: reviewPrompt({ app, change, diff, base, history: store.listReviews(change.id), round, focus }),
      codexBin: config.CODEX_BIN,
      model: config.CODEX_MODEL,
    });
    const review = store.addReview({
      change_id: change.id,
      round,
      verdict: result.verdict,
      summary: result.summary,
      findings_json: JSON.stringify(result.findings),
      head_sha: headSha,
    });

    const maxRounds = config.REVIEW_MAX_ROUNDS ?? 2;
    const actionable = result.findings.filter((f) => f.severity !== "nit");
    const autoFix = result.verdict === "changes_requested" && actionable.length > 0 && round <= maxRounds;

    await rv.update(channel, statusTs, formatReviewSlack(result, { round, pr, repo: app.repo, autoFix }));
    await github
      .commentIssue(app.repo, pr, formatReviewGitHub(result, { round, headSha }))
      .catch((err: unknown) => console.warn(`[review] PR 댓글 실패: ${describeError(err).split("\n")[0]}`));

    if (autoFix) {
      void requestChange(deps, app, {
        threadTs,
        userId: REVIEWER_ACTOR,
        request: reviewFixRequest(result, round),
        source: "review",
        reviewId: review.id,
      }).catch((err: unknown) => console.error("[review] 파피 반영 실패", err));
    } else if (result.verdict === "changes_requested" && actionable.length > 0) {
      const why = maxRounds > 0 ? `리비와 ${maxRounds}번 주고받았어요.` : "리뷰 자동 반영은 꺼져 있어요 (REVIEW_MAX_ROUNDS=0).";
      await deps.notifier.post(
        channel,
        `${why} 남은 지적은 사람이 판단해 주세요. 고칠 거면 이 스레드에서 \`@파피 …\` 로, 괜찮으면 [🚀 배포] 버튼을 누르면 돼요.`,
        { threadTs },
      );
    }
  } catch (err) {
    console.error(err);
    await rv.update(channel, statusTs, `⚠️ 리뷰하지 못했어요. PR 과 배포 버튼은 그대로예요.\n\`\`\`${describeError(err).slice(0, 1200)}\`\`\``);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 원격 기본 브랜치 이름 (`git ls-remote --symref origin HEAD`) */
async function defaultBranch(dir: string): Promise<string> {
  const out = await exec("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: dir, allowFail: true });
  const m = out.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
  return m?.[1] ?? "main";
}

async function prDiff(dir: string, base: string): Promise<string> {
  const ref = `origin/${base}`;
  let diff = await exec("git", ["diff", `${ref}...HEAD`], { cwd: dir, allowFail: true });
  // 얕은 클론이라 merge-base 를 못 찾으면 두 점 diff
  if (diff.code !== 0) diff = await exec("git", ["diff", ref, "HEAD"], { cwd: dir, allowFail: true });
  const text = diff.stdout;
  if (text.length <= MAX_DIFF_CHARS) return text;
  const stat = (await exec("git", ["diff", "--stat", ref, "HEAD"], { cwd: dir, allowFail: true })).stdout;
  return `${stat}\n(diff 가 길어 앞부분만 붙였어요. 나머지는 레포에서 직접 읽으세요)\n\n${text.slice(0, MAX_DIFF_CHARS)}`;
}

export function reviewPrompt(args: {
  app: AppRecord;
  change: ChangeRecord;
  diff: string;
  base: string;
  history: ReviewRecord[];
  round: number;
  focus?: string;
}): string {
  const { app, change, history } = args;
  const past = history.length
    ? [
        "",
        "[이전 리뷰와 파피의 반영]",
        ...history.map((r) =>
          [
            `- ${r.round}차 (${r.verdict}): ${r.summary}`,
            ...(JSON.parse(r.findings_json) as ReviewFinding[]).map((f) => `  - [${f.severity}] ${loc(f)} ${f.issue}`),
            `  → 파피: ${r.fix_summary ?? "(반영 기록 없음)"}`,
          ].join("\n"),
        ),
        "이미 반영된 지적을 다시 올리지 말고, 반영이 제대로 됐는지와 새로 생긴 문제를 봐라.",
      ].join("\n")
    : "";
  return [
    `너는 Slack 채널의 코드 리뷰어 "리비"다. 개발자 "파피"(다른 AI)가 앱 "${app.name}" (${app.repo}) 에 올린 PR 을 리뷰한다.`,
    "- 지금 디렉터리는 PR 브랜치를 클론한 것이다. 파일을 고치지 말고, 필요하면 읽기 명령(cat, rg, git log/diff/show)만 써라.",
    "- 레포의 CLAUDE.md·AGENTS.md·README.md·SPEC.md·docs/plans 를 먼저 보고 그 규칙과 요구사항 기준으로 판단해라.",
    "- 볼 것: 요구사항을 만족하는지, 버그·엣지 케이스, 보안(비밀값·권한·입력 검증), 깨질 빌드/타입, 문서(계획 문서·README) 누락.",
    "- 취향 차이는 nit 으로만. must = 머지하면 안 되는 문제, should = 고치는 게 좋은 문제.",
    "- must/should 가 하나도 없으면 verdict 는 approve.",
    "- summary 는 Slack 에 그대로 올라간다: 한국어 2~4줄, 사람(Evan, Joy)이 읽고 머지를 판단할 수 있게.",
    "- 결과는 주어진 JSON 스키마로만 답한다. line 은 모르면 null.",
    "",
    `[요구사항 (Slack, <@${change.requested_by}>)]`,
    change.request,
    args.focus ? `\n[이번에 사람이 특히 봐 달라고 한 것]\n${args.focus}` : "",
    past,
    "",
    `[PR #${change.pr_number} diff (origin/${args.base}...${change.branch}, ${args.round}차 리뷰)]`,
    args.diff || "(diff 없음)",
  ].join("\n");
}

/** 파피에게 넘길 반영 요청 */
export function reviewFixRequest(result: ReviewResult, round: number): string {
  return [
    `리비(리뷰어) ${round}차 리뷰: ${result.summary}`,
    ...result.findings.filter((f) => f.severity !== "nit").map((f, i) => `${i + 1}. [${f.severity}] ${loc(f)} ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ""}`),
  ].join("\n");
}

const ICON: Record<ReviewFinding["severity"], string> = { must: "🔴", should: "🟡", nit: "⚪" };

function loc(f: ReviewFinding): string {
  if (!f.file) return "";
  return f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
}

export function formatReviewSlack(
  r: ReviewResult,
  opts: { round: number; pr: number; repo: string; autoFix: boolean },
): string {
  const head =
    r.verdict === "approve"
      ? `✅ *${opts.round}차 리뷰: 머지해도 좋아 보여요*`
      : `📝 *${opts.round}차 리뷰: 고칠 게 있어요*`;
  const lines = r.findings.slice(0, 10).map((f) => `${ICON[f.severity]} ${loc(f)} ${f.issue}${f.suggestion ? `\n    ↳ ${f.suggestion}` : ""}`);
  const more = r.findings.length > 10 ? [`…외 ${r.findings.length - 10}건은 PR 댓글에`] : [];
  const tail = opts.autoFix
    ? "파피, 위 지적 반영 부탁해요."
    : `<https://github.com/${opts.repo}/pull/${opts.pr}|PR #${opts.pr}> 에도 같은 내용을 남겼어요.`;
  return [head, r.summary, ...lines, ...more, tail].filter(Boolean).join("\n");
}

export function formatReviewGitHub(r: ReviewResult, opts: { round: number; headSha: string }): string {
  const verdict = r.verdict === "approve" ? "✅ Approve" : "📝 Changes requested";
  const rows = r.findings.map(
    (f) => `- ${ICON[f.severity]} **${f.severity}** ${loc(f)} ${f.issue}${f.suggestion ? `\n  - 제안: ${f.suggestion}` : ""}`,
  );
  return [
    `### 🔍 리비 (리뷰어, Codex) · ${opts.round}차 리뷰 · ${verdict}`,
    "",
    r.summary,
    "",
    ...(rows.length ? rows : ["(지적 없음)"]),
    "",
    `<sub>리뷰한 커밋 ${opts.headSha.slice(0, 7)} · Slack 스레드와 같은 내용 · 머지는 Slack [배포] 버튼으로 사람이 결정</sub>`,
  ].join("\n");
}

/** 사람이 Slack 에서 `@리뷰어 …` 로 부른 경우: 이 스레드의 열린 PR 을 리뷰 */
export async function handleReviewerMention(
  deps: Deps,
  args: { channel: string; threadTs: string; userId: string; text: string },
): Promise<void> {
  const rv = deps.reviewerNotifier;
  if (!rv) return;
  const app = deps.store.getAppByChannel(args.channel);
  const change = app ? deps.store.getOpenChangeByThread(app.id, args.threadTs) : undefined;
  if (!app || !change) {
    await rv.post(
      args.channel,
      "저는 앱 채널에서 파피가 올린 PR 스레드 안에서 불러 주시면 리뷰해요. 예: PR 스레드에서 `@리비 보안 위주로 봐줘` 또는 `리비야 보안 위주로 봐줘`",
      { threadTs: args.threadTs },
    );
    return;
  }
  await scheduleReview(deps, app, change.id, { manual: true, focus: args.text || undefined });
}
