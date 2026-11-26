import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectRef } from "../integrations/github.js";
import type { AppRecord, ChangeRecord } from "../store.js";
import { describeError } from "../util/errors.js";
import type { Deps } from "./context.js";

/**
 * 요청 추적: Slack 요청 → GitHub 이슈 → docs/plans 계획 문서 → PR(Closes #이슈) → Project 보드.
 * 참고: upbit-cc / upbit-cdx 의 "이슈가 원장, PR마다 계획 문서, Project 는 상태 보기" 방식.
 * 이슈·Project 는 토큰 권한이 없을 수 있어 모두 best-effort: 실패해도 코드 수정·PR 흐름은 계속된다.
 */

export const SLACK_LABEL = { name: "slack-request", color: "4A154B", description: "Slack 채널에서 들어온 요청" };

type TrackDeps = Pick<Deps, "github" | "config">;

function logSkip(what: string, err: unknown): void {
  console.warn(`[tracking] ${what} 건너뜀: ${describeError(err).split("\n")[0]}`);
}

/** 새 앱 레포에 라벨과 Project 보드를 준비한다. 보드를 못 만들면 이유와 함께 null */
export async function setupRepoTracking(
  deps: TrackDeps,
  repo: string,
  title: string,
): Promise<{ project: ProjectRef | null; warning?: string }> {
  await deps.github
    .ensureLabel(repo, SLACK_LABEL.name, SLACK_LABEL.color, SLACK_LABEL.description)
    .catch((err) => logSkip("라벨 생성", err));
  if (!deps.config.GITHUB_PROJECTS) return { project: null };
  try {
    return { project: await deps.github.createProject(repo, title) };
  } catch (err) {
    logSkip("Project 생성", err);
    return {
      project: null,
      warning:
        "GitHub Project 보드는 만들지 못했어요 (토큰에 Projects 권한이 없어요). 개인 계정이면 classic PAT(project, repo)를 `GITHUB_PROJECT_TOKEN` 에 넣어주세요. 이슈·PR·계획 문서는 그대로 동작해요.",
    };
  }
}

/** Slack 요청 1건을 이슈로 남긴다. 만들지 못하면 null */
export async function openRequestIssue(
  deps: TrackDeps,
  app: AppRecord,
  args: { request: string; userId: string; slackLink?: string },
): Promise<number | null> {
  const body = [
    `Slack <#${app.slack_channel_id}> 에서 들어온 요청${args.slackLink ? ` ([스레드](${args.slackLink}))` : ""}. 요청자 Slack ID: \`${args.userId}\``,
    "",
    "## 요청",
    "",
    quote(args.request),
    "",
    "## 진행",
    "",
    "파이프라인 에이전트가 브랜치·계획 문서(`docs/plans/`)·PR을 만들고, PR이 병합(Slack [배포] 버튼)되면 이 이슈가 닫혀요.",
  ].join("\n");
  let issue: number;
  try {
    issue = await deps.github.createIssue(app.repo, firstLine(args.request).slice(0, 80), body, [SLACK_LABEL.name]);
  } catch (err) {
    // 라벨이 없는 레포(연결한 기존 레포 등)면 라벨 없이 한 번 더
    try {
      issue = await deps.github.createIssue(app.repo, firstLine(args.request).slice(0, 80), body);
    } catch {
      logSkip("이슈 생성", err);
      return null;
    }
  }
  await addToBoard(deps, app, issue, "In Progress");
  return issue;
}

/** Project 보드에 이슈/PR 추가 (보드가 없으면 아무것도 안 함) */
export async function addToBoard(deps: TrackDeps, app: AppRecord, number: number, status?: string): Promise<void> {
  if (!app.project_id) return;
  await deps.github.addToProject(app.project_id, app.repo, number, status).catch((err) => logSkip("Project 항목 추가", err));
}

export function planPath(change: Pick<ChangeRecord, "id" | "branch" | "issue_number">): string {
  const topic = change.branch.replace(/^pipeline\/\d+-/, "") || "change";
  const prefix = change.issue_number ? `issue-${change.issue_number}` : `change-${change.id}`;
  return `docs/plans/${prefix}-${topic}.md`;
}

/**
 * 계획 문서를 준비한다. 없으면 뼈대를 만들고, 이어서 수정하는 요청이면 변경 기록에 한 줄 덧붙인다.
 * 에이전트가 이 파일을 채운다 (프롬프트 참고). 파이프라인이 직접 만들어 두므로 문서 없는 PR은 생기지 않는다.
 */
export async function preparePlanDoc(
  dir: string,
  args: { app: AppRecord; change: ChangeRecord; request: string; userId: string; slackLink?: string; today?: string },
): Promise<string> {
  const rel = planPath(args.change);
  const file = join(dir, rel);
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const exists = await access(file).then(
    () => true,
    () => false,
  );
  if (exists) {
    const text = await readFile(file, "utf8");
    const entry = [`- ${today}: 추가 요청 (\`${args.userId}\`)`, "", indent(quote(args.request)), ""].join("\n");
    await writeFile(file, text.trimEnd() + "\n" + entry);
    return rel;
  }
  await mkdir(dirname(file), { recursive: true });
  const { app, change } = args;
  const issue = change.issue_number ? `#${change.issue_number}` : "(이슈 없음)";
  await writeFile(
    file,
    [
      `# ${firstLine(args.request)}`,
      "",
      `- Issue: ${issue}`,
      "- PR: 생성 후 자동 연결",
      `- 요청: ${args.slackLink ? `[Slack 스레드](${args.slackLink})` : `Slack <#${app.slack_channel_id}>`} / \`${args.userId}\``,
      `- 작성일: ${today}`,
      `- 브랜치: \`${change.branch}\``,
      "",
      "## 문제와 근거",
      "",
      quote(args.request),
      "",
      "<!-- 에이전트: 요청을 어떻게 이해했는지, 관련 코드·기존 계획 문서에서 확인한 사실. 가설은 가설이라고 표시 -->",
      "",
      "## 범위와 결정",
      "",
      "<!-- 에이전트: 바꾸는 동작과 이유, 검토했다가 버린 대안과 이유, 범위 밖으로 남긴 것 -->",
      "",
      "## 검증",
      "",
      "<!-- 에이전트: 실제로 실행한 명령과 결과, 프리뷰에서 확인할 것, 확인하지 못한 부분 -->",
      "",
      "## 변경 기록",
      "",
      `- ${today}: 처음 작성 (파이프라인)`,
      "",
    ].join("\n"),
  );
  return rel;
}

/** 에이전트 작업이 끝나면 요약을 계획 문서의 변경 기록에 남긴다 (Slack에만 남지 않게) */
export async function recordAgentSummary(dir: string, rel: string, summary: string, today?: string): Promise<void> {
  if (!summary.trim()) return;
  const file = join(dir, rel);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  const day = today ?? new Date().toISOString().slice(0, 10);
  const entry = [`- ${day}: 에이전트 작업 결과 (Slack에 올린 요약)`, "", indent(quote(summary)), ""].join("\n");
  await writeFile(file, text.trimEnd() + "\n" + entry);
}

export function planPrompt(rel: string): string {
  return [
    "",
    "",
    "[계획 문서]",
    `이 작업의 계획 문서는 \`${rel}\` 다. 파이프라인이 뼈대를 만들어 두었다.`,
    "- 코드를 고치기 전에 `docs/plans/` 의 다른 문서를 훑어 관련 결정을 확인하고, 이 문서의 '문제와 근거', '범위와 결정'(버린 대안 포함)을 채운다.",
    "- 작업이 끝나면 '검증'에 실제로 실행한 명령과 결과, 확인하지 못한 부분을 적고 '변경 기록'을 갱신한다. HTML 주석 안내문은 지운다.",
    "- 이 문서와 SPEC.md·README.md 만 읽은 사람이 Slack 없이 맥락을 알 수 있게 쓴다: 요청에서 정한 조건, 고른 이유, 남은 질문까지.",
    "- 실행하지 않은 검사를 통과했다고 쓰지 않는다. 비밀값·개인정보는 적지 않는다.",
  ].join("\n");
}

export function prBody(args: {
  repo: string;
  branch: string;
  issue: number | null;
  plan: string;
  userId: string;
  request: string;
  summary: string;
}): string {
  return [
    "## 문제와 변경",
    "",
    args.issue ? `Closes #${args.issue}` : "(연결된 이슈 없음)",
    "",
    `계획 문서: [${args.plan}](https://github.com/${args.repo}/blob/${args.branch}/${args.plan}) (근거·결정·검증은 문서에)`,
    "",
    `Slack 요청 (<@${args.userId}>):`,
    "",
    quote(args.request),
    "",
    "## 에이전트 요약",
    "",
    args.summary || "(요약 없음)",
    "",
    "## 배포",
    "",
    "Vercel 프리뷰는 PR의 Vercel 댓글에서 확인. 병합(=프로덕션 배포)은 Slack [배포] 버튼으로 사람이 결정합니다.",
  ].join("\n");
}

function indent(s: string): string {
  return s.replace(/^/gm, "  ");
}

function quote(s: string): string {
  return "> " + s.trim().replace(/\n/g, "\n> ");
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim() || "Slack 요청";
}
