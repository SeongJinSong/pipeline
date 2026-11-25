import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

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

export class ClaudeClient {
  private client: Anthropic;
  constructor(
    private model: string,
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  /** 아이디어 → 구조화된 MVP 스펙 */
  async ideaToSpec(idea: string): Promise<AppSpec> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(AppSpecSchema) },
      system: SPEC_SYSTEM,
      messages: [{ role: "user", content: `아이디어:\n${idea}` }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("Claude가 이 아이디어의 스펙 작성을 거절했어요. 표현을 바꿔 다시 시도해 주세요.");
    }
    if (!response.parsed_output) throw new Error("스펙 JSON 파싱에 실패했어요.");
    return response.parsed_output;
  }
}
