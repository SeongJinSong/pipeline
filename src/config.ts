import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );

const schema = z.object({
  // Slack (Socket Mode: 공개 URL 없이 맥북/서버 어디서나 실행 가능)
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  /** 코드 변경·배포를 승인할 수 있는 Slack Member ID (Evan, 동업자) */
  SLACK_ALLOWED_USERS: csv,
  /** true 면 워크스페이스 누구나 앱 만들기·코드 수정 요청·배포 가능 (내부 소수 인원용). 레포 연결/삭제는 SLACK_ALLOWED_USERS 만 */
  SLACK_OPEN_ACCESS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** 새 앱 채널 이름 접두어 */
  SLACK_CHANNEL_PREFIX: z.string().default("app-"),

  // Claude
  /** AGENT_RUNNER=sdk 일 때만 필요. claude-cli(기본)는 로컬 Claude Code 로그인을 쓴다 */
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  /**
   * 코드 수정 실행 방식
   * - claude-cli: 이 머신에 로그인된 Claude Code(구독)로 실행. API 토큰 과금 없음 (맥에서 돌릴 때 권장)
   * - sdk:        Claude Agent SDK + ANTHROPIC_API_KEY (종량제, 서버에서 돌릴 때)
   */
  AGENT_RUNNER: z.enum(["claude-cli", "sdk"]).default("claude-cli"),
  /** claude-cli 러너가 실행할 바이너리 경로 */
  CLAUDE_BIN: z.string().default("claude"),
  /** sdk 러너에서 한 번의 코드 수정 작업에 쓸 수 있는 최대 비용(USD) */
  AGENT_MAX_BUDGET_USD: z.coerce.number().default(10),

  // GitHub
  GITHUB_TOKEN: z.string().min(1),
  /** 새 앱 레포가 만들어질 owner (개인 계정 또는 org) */
  GITHUB_OWNER: z.string().min(1),
  /**
   * 새 앱마다 GitHub Project 보드를 만들 때 쓰는 토큰 (선택).
   * 개인 계정 Project 는 fine-grained PAT 로 만들 수 없어 classic PAT(scope: project, repo)가 필요하다.
   * 비우면 GITHUB_TOKEN 으로 시도하고, 실패하면 보드 없이 진행한다.
   */
  GITHUB_PROJECT_TOKEN: z.string().optional(),
  /** false 면 GitHub Project 보드를 만들지 않는다 */
  GITHUB_PROJECTS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  GITHUB_PRIVATE_REPOS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Vercel
  VERCEL_TOKEN: z.string().min(1),
  VERCEL_TEAM_ID: z.string().optional(),

  // AWS (선택: 백엔드가 필요한 앱만)
  AWS_REGION: z.string().default("ap-northeast-2"),
  /** infra/bootstrap 에서 만든 GitHub Actions OIDC 배포 역할 */
  AWS_DEPLOY_ROLE_ARN: z.string().optional(),
  /** infra/bootstrap 에서 만든 Terraform state 버킷 */
  AWS_TF_STATE_BUCKET: z.string().optional(),

  // 앱인토스 (선택: 토스 미니앱으로 내는 앱)
  /** 앱인토스 콘솔 워크스페이스 → '키' 메뉴에서 발급한 API 키. 없으면 번들 업로드를 건너뛴다 */
  APPS_IN_TOSS_API_KEY: z.string().optional(),
  /** true 면 PR마다 테스트 번들을 올려 토스앱 테스트 링크를 스레드에 남긴다 (출시는 콘솔에서 사람이) */
  APPS_IN_TOSS_PR_UPLOADS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * true 면 서버 Claude Code 에 등록·로그인된 앱인토스 콘솔 MCP 를 쓴다: Slack `@pipeline 토스 …` 콘솔 작업,
   * API 키가 없을 때 번들 업로드. 등록·로그인은 deploy/README '앱인토스 콘솔 MCP'.
   */
  TOSS_CONSOLE_MCP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /** 봇을 부르는 한글 이름 (쉼표 구분). `@파피 …`, `파피야 …` 로 시작하는 채널 메시지를 멘션처럼 받는다 */
  BOT_CALL_NAMES: z
    .string()
    .default("파피")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),

  /** /newapp 진행 상황을 남길 채널 ID (없으면 요청자 DM) */
  SLACK_LAUNCH_CHANNEL: z.string().optional(),

  // 로컬 경로
  DATA_DIR: z.string().default("./data"),
  WORKSPACE_DIR: z.string().default("./workspaces"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`환경변수 설정이 올바르지 않습니다 (.env.example 참고):\n${lines.join("\n")}`);
  }
  if (parsed.data.AGENT_RUNNER === "sdk" && !parsed.data.ANTHROPIC_API_KEY) {
    throw new Error("AGENT_RUNNER=sdk 에는 ANTHROPIC_API_KEY 가 필요해요. 로컬 Claude Code 를 쓰려면 AGENT_RUNNER=claude-cli");
  }
  return parsed.data;
}

export const awsEnabled = (c: Config) => Boolean(c.AWS_DEPLOY_ROLE_ARN && c.AWS_TF_STATE_BUCKET);
