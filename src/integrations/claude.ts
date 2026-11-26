import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { tmpdir } from "node:os";
import { z } from "zod";
import { exec } from "../util/exec.js";

/** 만들기 전에 사람처럼 따져보는 판단: 직접 만들지, 기존 서비스를 쓸지, 섞을지, 접을지 */
export const AdviceSchema = z.object({
  verdict: z
    .enum(["build", "buy", "hybrid", "drop"])
    .describe("build=직접 만들기, buy=기존 서비스/앱을 쓰는 게 나음, hybrid=핵심만 만들고 어려운 부분은 기존 서비스, drop=하지 않는 게 나음"),
  summary: z.string().describe("동업자에게 말하듯 솔직한 한국어 의견 2~4줄. 왜 그렇게 판단했는지"),
  alternatives: z
    .array(
      z.object({
        name: z.string(),
        what: z.string().describe("무엇을 대신해주는지"),
        price: z.string().describe("대략 가격 (예: 무료, 월 $10, 거래당 3.3%). 모르면 '확인 필요'"),
        url: z.string().describe("공식 사이트 URL. 모르면 빈 문자열"),
      }),
    )
    .describe("이미 있는 앱·SaaS·API·오픈소스 중 쓸 만한 것 (최대 5개). 없으면 빈 배열"),
  hard_parts: z
    .array(z.string())
    .describe("직접 만들면 어렵거나 비싸거나 위험한 부분 (결제, 인증, 법·규제, 실시간, 지도 등)과 어떻게 피할지"),
});
export type Advice = z.infer<typeof AdviceSchema>;

export const AppSpecSchema = z.object({
  advice: AdviceSchema.describe("스펙을 쓰기 전에 먼저 내리는 판단"),
  name: z.string().describe("짧은 서비스 이름 (사람이 읽는 이름, 한글 가능)"),
  slug: z
    .string()
    .describe("영문 소문자/숫자/하이픈만 쓴 식별자. 레포·Slack 채널·Vercel 프로젝트 이름으로 사용"),
  one_liner: z.string().describe("한 줄 설명"),
  target_users: z.string(),
  core_features: z.array(z.string()).describe("MVP에 꼭 들어갈 기능 3~6개"),
  pages: z.array(z.object({ path: z.string(), purpose: z.string() })),
  platform: z
    .enum(["web", "toss"])
    .describe(
      "web=웹앱(Vercel)만. toss=토스 앱 안의 미니앱(앱인토스)으로도 낸다. 사람이 앱인토스·토스 미니앱·토스 앱 안에서 쓰는 서비스를 원할 때만 toss",
    ),
  needs_backend: z
    .boolean()
    .describe("DB 저장, 외부 API 비밀키, 배치 작업 등 서버가 꼭 필요하면 true. 정적/클라이언트만으로 되면 false"),
  data_model: z
    .array(z.object({ entity: z.string(), fields: z.array(z.string()) }))
    .describe("needs_backend가 false면 빈 배열"),
  open_questions: z.array(z.string()).describe("사람이 결정해야 할 질문 (최대 3개)"),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;

const SPEC_SYSTEM = `너는 1인 창업자와 동업자를 돕는 프로덕트 매니저이자 솔직한 공동창업자다.
무조건 만들자고 하지 않는다. 먼저 사람처럼 자유롭게 따져본다(advice):
- 이미 잘 되는 앱·SaaS·API·오픈소스가 있으면 이름과 대략 가격을 대고, 그걸 쓰는 게 나으면 buy 라고 말한다.
- 결제, 인증, 지도, 채팅, 메일 발송, 법·규제(개인정보, 금융, 의료)처럼 직접 만들면 어렵거나 위험한 부분은 저렴한 기존 서비스를 권한다 (hybrid).
- 시장·비용·시간 면에서 하지 않는 게 낫다고 보면 drop 이라고 솔직히 말한다.
- 웹 검색 도구가 있으면 대안과 가격을 확인한다. 확인 못 한 가격은 '확인 필요'라고 쓴다. 지어내지 않는다.
그다음 아이디어를 하루 안에 만들 수 있는 MVP 스펙으로 좁힌다. buy/drop 이어도 만든다면 어떻게 할지 스펙은 채운다.
- 기술 스택은 고정: Next.js(App Router, TypeScript, Tailwind) on Vercel. 백엔드가 필요하면 AWS Lambda + DynamoDB.
- 배포 대상(platform): 기본은 web. 사람이 앱인토스(토스 미니앱, 토스 앱 안의 서비스)를 원하면 toss 로 한다. toss 도 같은 Next.js 코드를
  정적으로 내보내 토스 앱 미니앱 번들로 올린다 (웹 주소도 함께 생김). 그래서 Next.js 서버 기능(API 라우트, 서버 액션)은 못 쓰고 서버 일은 AWS Lambda 로 한다.
  toss 라면 advice 에서 짚는다: 사용자는 만 19세 이상 토스 사용자, 출시마다 토스 검수 필요, 토스 로그인·인앱 결제·토스페이·포인트 지급은 사업자 등록이 먼저 필요.
  웹으로 시작해도 나중에 toss 로 바꿀 수 있다.
- 기능은 작게. "있으면 좋은 것"은 빼고 open_questions로 넘긴다.
- 모든 설명은 한국어로 쓴다. slug만 영문.`;

/** PRD 스레드에서 사람 피드백으로 스펙을 고칠 때의 응답: 스레드에 올릴 답 + 고친 스펙 */
export const SpecRevisionSchema = z.object({
  reply: z
    .string()
    .describe("스레드에 올릴 한국어 답 2~5줄. 무엇을 바꿨는지, 질문에 대한 답. 바꿀 게 없으면 그 이유"),
  spec: AppSpecSchema,
});
export type SpecRevision = z.infer<typeof SpecRevisionSchema>;

/** PRD 스레드의 대화 한 줄 */
export interface SpecTurn {
  role: "user" | "assistant";
  text: string;
}

const REVISE_SYSTEM = `${SPEC_SYSTEM}
지금은 Slack 스레드에서 사람과 대화하며 이미 만든 MVP 스펙(PRD)을 다듬는 중이다.
- 사람의 마지막 메시지를 반영해 스펙 전체를 다시 돌려준다. 요청과 관계없는 부분은 그대로 둔다.
- 질문이면 reply 에서 답하고, 스펙은 필요할 때만 바꾼다.
- 사람이 결정한 open_questions 는 목록에서 빼고 스펙에 반영한다.
- slug 는 사람이 바꾸라고 하지 않는 한 유지한다.
- 사람이 반론하거나 새 정보를 주면 advice 도 다시 판단한다. 맞장구만 치지 말고 근거로 말한다.`;

export function revisionPrompt(idea: string, spec: AppSpec, history: SpecTurn[], message: string): string {
  const convo = history.map((t) => `${t.role === "user" ? "사람" : "PM"}: ${t.text}`).join("\n");
  return [
    `처음 아이디어:\n${idea}`,
    `현재 스펙(JSON):\n${JSON.stringify(spec, null, 2)}`,
    convo ? `지금까지의 대화:\n${convo}` : "",
    `사람의 새 메시지:\n${message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface SpecGeneratorOptions {
  model: string;
  /** "claude-cli": 로컬 Claude Code 구독으로 실행 (API 키 불필요) / "sdk": Messages API */
  runner: "claude-cli" | "sdk";
  apiKey?: string;
  claudeBin?: string;
}

export class ClaudeClient {
  private client: Anthropic | undefined;
  constructor(private opts: SpecGeneratorOptions) {
    if (opts.runner === "sdk") this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  /** 아이디어 → 구조화된 MVP 스펙 */
  async ideaToSpec(idea: string): Promise<AppSpec> {
    return this.structured(AppSpecSchema, SPEC_SYSTEM, `아이디어:\n${idea}`);
  }

  /** PRD 스레드 대화 → 고친 스펙 + 답. 대화 전체를 매번 넘겨 맥락을 유지한다 (CLI 는 상태가 없음). */
  async reviseSpec(idea: string, spec: AppSpec, history: SpecTurn[], message: string): Promise<SpecRevision> {
    return this.structured(SpecRevisionSchema, REVISE_SYSTEM, revisionPrompt(idea, spec, history, message));
  }

  private async structured<T extends z.ZodType>(schema: T, system: string, prompt: string): Promise<z.infer<T>> {
    return this.client ? this.viaApi(this.client, schema, system, prompt) : this.viaCli(schema, system, prompt);
  }

  private async viaApi<T extends z.ZodType>(client: Anthropic, schema: T, system: string, prompt: string): Promise<z.infer<T>> {
    const response = await client.messages.parse({
      model: this.opts.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(schema as never) },
      system,
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("Claude가 이 요청을 거절했어요. 표현을 바꿔 다시 시도해 주세요.");
    }
    if (!response.parsed_output) throw new Error("스펙 JSON 파싱에 실패했어요.");
    return response.parsed_output as z.infer<T>;
  }

  /** 로컬 Claude Code(`claude -p --json-schema`)로 실행. 도구 없이 텍스트만. */
  private async viaCli<T extends z.ZodType>(schema: T, system: string, prompt: string): Promise<z.infer<T>> {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const { stdout } = await exec(this.opts.claudeBin ?? "claude", structuredCliArgs(this.opts.model, schema, system, prompt), {
      cwd: tmpdir(),
      env,
    });
    return parseStructuredCliOutput(stdout, schema);
  }
}

/** CLI 의 스키마 검증기는 $schema 메타 키를 모르므로 뺀다 */
function cliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function structuredCliArgs(model: string, schema: z.ZodType, system: string, prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(cliJsonSchema(schema)),
    // 대안·가격 확인용 웹 검색만 허용 (파일·셸 도구 없음)
    "--tools",
    "WebSearch,WebFetch",
    "--allowedTools",
    "WebSearch,WebFetch",
    "--max-turns",
    "12",
    "--model",
    model,
    "--system-prompt",
    system,
  ];
}

export function specCliArgs(model: string, idea: string): string[] {
  return structuredCliArgs(model, AppSpecSchema, SPEC_SYSTEM, `아이디어:\n${idea}`);
}

/** `claude -p --output-format json` 결과에서 구조화된 출력을 꺼내 검증 */
export function parseStructuredCliOutput<T extends z.ZodType>(stdout: string, schema: T): z.infer<T> {
  let parsed: { is_error?: boolean; result?: string; structured_output?: unknown; subtype?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI 출력이 JSON이 아니에요: ${stdout.slice(0, 300)}`);
  }
  if (parsed.is_error) throw new Error(`스펙 작성 실패 (${parsed.subtype}): ${String(parsed.result ?? "").slice(0, 300)}`);
  let candidate = parsed.structured_output;
  if (candidate === undefined && parsed.result) {
    const m = parsed.result.match(/\{[\s\S]*\}/);
    if (m) candidate = JSON.parse(m[0]);
  }
  const out = schema.safeParse(candidate);
  if (!out.success) throw new Error(`스펙 JSON 형식이 맞지 않아요: ${out.error.message.slice(0, 300)}`);
  return out.data;
}

export function parseSpecCliOutput(stdout: string): AppSpec {
  return parseStructuredCliOutput(stdout, AppSpecSchema);
}
