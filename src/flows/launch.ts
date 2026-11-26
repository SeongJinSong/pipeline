import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { awsEnabled } from "../config.js";
import { APPS_IN_TOSS_CONSOLE_URL } from "../integrations/appsintoss.js";
import { commitAll, configureGitIdentity } from "../integrations/github.js";
import type { AppSpec, SpecTurn } from "../integrations/claude.js";
import { exec } from "../util/exec.js";
import { channelName, toSlug } from "../util/names.js";
import { renderTemplate } from "../util/template.js";
import { specBlocks } from "../slack/blocks.js";
import { requestChange } from "./change.js";
import type { Deps } from "./context.js";
import { describeError } from "../util/errors.js";
import { setupRepoTracking } from "./tracking.js";

/**
 * 아이디어 → 스펙 → GitHub 레포 → Vercel 프로젝트 → (AWS 배포 설정) → Slack 채널 → 첫 MVP 구현.
 * originChannel/originTs: /newapp 을 입력한 곳 (진행 상황을 여기에 남긴다)
 */
export async function launchApp(
  deps: Deps,
  args: {
    idea: string;
    userId: string;
    originChannel: string;
    /** PRD 스레드에서 확정한 스펙. 없으면 아이디어로 바로 만든다 */
    spec?: AppSpec;
    /** 진행 상황을 남길 기존 스레드 (PRD 스레드) */
    threadTs?: string;
    /** PRD 스레드 대화 (SPEC.md 에 결정 기록으로 남김) */
    history?: SpecTurn[];
  },
): Promise<number | undefined> {
  const { config, store, claude, github, vercel, notifier } = deps;
  const log =
    args.threadTs ??
    (await notifier.post(args.originChannel, `💡 <@${args.userId}> 아이디어 접수! 스펙 정리 중…\n> ${args.idea}`));
  // 앱 채널이 생기면 그 뒤 진행 상황은 앱 채널에도 남긴다 (만드는 과정 기록)
  let appChannel: string | undefined;
  const step = async (text: string) => {
    await notifier.post(args.originChannel, text, { threadTs: log });
    if (appChannel && appChannel !== args.originChannel) await notifier.post(appChannel, text).catch(() => undefined);
  };

  let appId: number | undefined;
  const dir = join(config.WORKSPACE_DIR, `init-${Date.now()}`);
  try {
    // 1) 스펙
    const spec = args.spec ?? (await claude.ideaToSpec(args.idea));
    const slug = uniqueSlug(deps, toSlug(spec.slug || spec.name));
    if (!args.spec) await notifier.post(args.originChannel, `📋 ${spec.name} 스펙`, { threadTs: log, blocks: specBlocks(spec) });
    await step(`🚀 출시 시작: \`${slug}\``);

    // 2) GitHub 레포
    const repo = await github.createRepo(slug, spec.one_liner, config.GITHUB_PRIVATE_REPOS);
    const app = store.createApp({ slug, name: spec.name, idea: args.idea, repo, created_by: args.userId });
    appId = app.id;
    const needsBackend = spec.needs_backend && awsEnabled(config);
    const toss = spec.platform === "toss";
    store.updateApp(app.id, { spec_json: JSON.stringify(spec), needs_backend: needsBackend ? 1 : 0 });
    await step(`📦 GitHub 레포 생성: https://github.com/${repo}`);

    // 2-1) 요청 추적: 라벨 + Project 보드 (이슈 템플릿·PR 템플릿·docs/plans 는 템플릿에 들어 있다)
    const tracking = await setupRepoTracking(deps, repo, spec.name);
    if (tracking.project) {
      store.updateApp(app.id, { project_id: tracking.project.id, project_url: tracking.project.url });
      await step(`📋 GitHub Project 보드: ${tracking.project.url}`);
    } else if (tracking.warning) {
      await step(`⚠️ ${tracking.warning}`);
    }

    // 3) Slack 채널
    const chName = channelName(config.SLACK_CHANNEL_PREFIX, slug);
    const channelId = await notifier.createChannel(chName, `${spec.name} — ${spec.one_liner}`);
    await notifier.invite(channelId, [...new Set([args.userId, ...config.SLACK_ALLOWED_USERS])]);
    store.updateApp(app.id, { slack_channel_id: channelId });
    appChannel = channelId;
    await notifier.post(channelId, `🛠 *${spec.name}* 만드는 중이에요. 진행 상황을 여기에 남길게요.\n> ${args.idea}`);
    await notifier.post(channelId, `📋 ${spec.name} 스펙`, { blocks: specBlocks(spec) });
    const prdLink = await notifier.permalink?.(args.originChannel, log).catch(() => undefined);
    if (prdLink) await notifier.post(channelId, `🧵 PRD를 다듬은 대화: ${prdLink}`);
    await step(`💬 Slack 채널 생성: <#${channelId}>`);

    // 4) 템플릿 커밋 (Vercel 프로젝트보다 먼저 push 해야 첫 배포가 바로 잡힌다)
    const productionUrl = `https://${slug}.vercel.app`;
    await mkdir(dir, { recursive: true });
    await renderTemplate(
      dir,
      {
        APP_NAME: spec.name,
        APP_SLUG: slug,
        APP_ONE_LINER: spec.one_liner,
        AWS_REGION: config.AWS_REGION,
        CHANNEL: chName,
        PRODUCTION_URL: productionUrl,
        PROJECT_URL: tracking.project?.url ?? "(없음)",
      },
      { withBackend: needsBackend, withToss: toss },
    );
    await writeFile(join(dir, "SPEC.md"), specMarkdown(spec, args.idea, args.history));
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await configureGitIdentity(dir);
    await commitAll(dir, `chore: ${spec.name} 초기 템플릿`);
    await exec("git", ["remote", "add", "origin", github.authedUrl(repo)], { cwd: dir });
    await github.push(dir, "main");

    // 5) Vercel
    const project = await vercel.createProject(slug, repo);
    store.updateApp(app.id, { vercel_project_id: project.id, production_url: productionUrl });
    await step(`▲ Vercel 프로젝트 생성: ${productionUrl}`);

    // 6) AWS (백엔드가 필요한 앱만): GitHub Actions가 OIDC로 배포하도록 변수/시크릿 주입
    if (needsBackend) {
      await github.setVariable(repo, "AWS_DEPLOY_ROLE_ARN", config.AWS_DEPLOY_ROLE_ARN!);
      await github.setVariable(repo, "AWS_REGION", config.AWS_REGION);
      await github.setVariable(repo, "AWS_TF_STATE_BUCKET", config.AWS_TF_STATE_BUCKET!);
      await github.setVariable(repo, "VERCEL_PROJECT_ID", project.id);
      if (config.VERCEL_TEAM_ID) await github.setVariable(repo, "VERCEL_TEAM_ID", config.VERCEL_TEAM_ID);
      await github.setSecret(repo, "VERCEL_TOKEN", config.VERCEL_TOKEN);
      await step("☁️ AWS 백엔드 배포 설정 완료 (Lambda + API Gateway + DynamoDB, main 머지 시 자동 배포)");
    } else if (spec.needs_backend) {
      await step("⚠️ 백엔드가 필요한 앱이지만 AWS 설정(AWS_DEPLOY_ROLE_ARN, AWS_TF_STATE_BUCKET)이 없어 웹만 만들었어요.");
    }

    // 7) 앱인토스: 콘솔 앱 등록은 API 로 못 해서 사람이 한다. appName 은 등록 후 못 바꾸니 정확한 값을 알려준다
    if (toss) {
      await step(
        [
          `📱 앱인토스 미니앱으로도 만들어요. 콘솔(${APPS_IN_TOSS_CONSOLE_URL})의 워크스페이스 → 앱 +등록하기에서 *appName \`${slug}\`* 로 앱을 등록해 주세요.`,
          `   등록 전에는 번들 업로드가 실패해요. 이미 쓰는 이름이면 다른 이름으로 등록하고 이 채널에 "appName 을 ○○로 바꿔줘"라고 알려 주세요.`,
          deps.toss?.enabled
            ? "   PR마다 테스트 번들을 올려 토스앱 테스트 링크를 남길게요. 출시는 콘솔에서 검토 요청 → 출시하기를 눌러야 돼요."
            : "   ⚠️ 봇 서버에 APPS_IN_TOSS_API_KEY 가 없어서 번들 업로드는 키를 넣은 뒤부터 돼요.",
        ].join("\n"),
      );
    }

    store.updateApp(app.id, { status: "ready" });
    await step(`✅ 준비 완료! <#${channelId}> 에서 요구사항을 말하면 코드가 바뀌고 배포돼요.`);

    // 8) 새 채널에 안내 + 첫 MVP 구현 요청
    const fresh = store.getApp(app.id)!;
    const intro = await notifier.post(
      channelId,
      [
        `*${spec.name}* 채널이에요 👋`,
        `• 레포: https://github.com/${repo}`,
        `• 프로덕션: ${productionUrl}`,
        ...(toss ? [`• 앱인토스 미니앱 appName: \`${slug}\` (운영 방법: docs/apps-in-toss.md)`] : []),
        ...(fresh.project_url ? [`• 작업 보드: ${fresh.project_url}`] : []),
        `• 사용법: 이 채널에 요구사항을 쓰면 → 이슈 등록 → 코드 수정 + 계획 문서(docs/plans) → PR + 프리뷰 → [배포] 버튼으로 반영.`,
        `• 같은 스레드에 답하면 같은 PR에 이어서 수정해요.`,
        ``,
        `먼저 스펙대로 MVP를 만들어 볼게요.`,
      ].join("\n"),
    );
    await requestChange(deps, fresh, {
      threadTs: intro,
      userId: args.userId,
      request: "SPEC.md 의 MVP를 구현해줘. 핵심 기능과 페이지를 모두 동작하게 만들고, 깔끔한 기본 UI를 적용해줘.",
    });
  } catch (err) {
    console.error(err);
    if (appId) store.updateApp(appId, { status: "failed" });
    await step(`❌ 출시 중 오류: \`\`\`${describeError(err).slice(0, 1500)}\`\`\``);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return appId;
}

function uniqueSlug(deps: Deps, base: string): string {
  let slug = base;
  for (let i = 2; deps.store.getAppBySlug(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export function specMarkdown(spec: AppSpec, idea: string, history: SpecTurn[] = []): string {
  const lines = [
    `# ${spec.name}`,
    "",
    `> ${spec.one_liner}`,
    "",
    "## 만들기 전 판단",
    `- 결론: ${spec.advice.verdict}`,
    `- ${spec.advice.summary.replace(/\n+/g, " ")}`,
    ...spec.advice.alternatives.map((a) => `- 대안: ${a.name}: ${a.what} (${a.price})${a.url ? ` ${a.url}` : ""}`),
    ...spec.advice.hard_parts.map((h) => `- 어려운 부분: ${h}`),
    "",
    "## 처음 아이디어",
    idea,
    "",
    "## 대상 사용자",
    spec.target_users,
    "",
    "## 핵심 기능 (MVP)",
    ...spec.core_features.map((f) => `- ${f}`),
    "",
    "## 페이지",
    ...spec.pages.map((p) => `- \`${p.path}\` — ${p.purpose}`),
    "",
    "## 배포 대상",
    spec.platform === "toss"
      ? "- 웹(Vercel) + 앱인토스(토스 미니앱). 운영 방법은 [docs/apps-in-toss.md](docs/apps-in-toss.md)"
      : "- 웹(Vercel)",
  ];
  if (spec.needs_backend && spec.data_model.length) {
    lines.push("", "## 데이터 모델", ...spec.data_model.map((d) => `- **${d.entity}**: ${d.fields.join(", ")}`));
  }
  if (spec.open_questions.length) {
    lines.push("", "## 열린 질문", ...spec.open_questions.map((q) => `- ${q}`));
  }
  if (history.length) {
    lines.push(
      "",
      "## PRD 대화 기록",
      "Slack PRD 스레드에서 오간 결정. 코드 수정 시 참고.",
      "",
      ...history.map((t) => `- **${t.role === "user" ? "사람" : "PM"}**: ${t.text.replace(/\n+/g, " ")}`),
    );
  }
  return lines.join("\n") + "\n";
}
