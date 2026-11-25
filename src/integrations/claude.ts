import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { tmpdir } from "node:os";
import { z } from "zod";
import { exec } from "../util/exec.js";

export const AppSpecSchema = z.object({
  name: z.string().describe("짧은 서비스 이름 (사람이 읽는 이름, 한글 가능)"),
  slug: z
    .string()
    .describe("영문 소문자/숫자/하이픈만 쓴 식별자. 레포·Slack 채널·Vercel 프로젝트 이름으로 사용"),
  one_liner: z.string().describe("한 줄 설명"),
  target_users: z.string(),
  core_features: z.array(z.string()).describe("MVP에 꼭 들어갈 기능 3~6개"),
  pages: z.array(z.object({ path: z.string(), purpose: z.string() })),
  needs_backend: z
    .boolean()
    .describe("DB 저장, 외부 API 비밀키, 배치 작업 등 서버가 꼭 필요하면 true. 정적/클라이언트만으로 되면 false"),
  data_model: z
    .array(z.object({ entity: z.string(), fields: z.array(z.string()) }))
    .describe("needs_backend가 false면 빈 배열"),
  open_questions: z.array(z.string()).describe("사람이 결정해야 할 질문 (최대 3개)"),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;

const SPEC_SYSTEM = `너는 1인 창업자와 동업자를 돕는 프로덕트 매니저다.
아이디어 한두 줄을 받아 하루 안에 만들 수 있는 MVP 스펙으로 좁힌다.
- 기술 스택은 고정: Next.js(App Router, TypeScript, Tailwind) on Vercel. 백엔드가 필요하면 AWS Lambda + DynamoDB.
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
- slug 는 사람이 바꾸라고 하지 않는 한 유지한다.`;

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
    "--tools",
    "",
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
