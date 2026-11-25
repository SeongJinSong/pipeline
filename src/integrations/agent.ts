import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface AgentRunResult {
  ok: boolean;
  summary: string;
  costUsd: number;
  turns: number;
}

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  /** 진행 상황을 Slack 스레드에 흘려보내기 위한 콜백 (도구 사용 요약) */
  onProgress?: (line: string) => void;
}

const SYSTEM_APPEND = `
너는 Slack 채널에서 요구사항을 받아 이 레포의 코드를 직접 고치는 엔지니어다.
- 요구사항을 만족하는 최소한의 변경을 한다. 관련 없는 리팩터링은 하지 않는다.
- 변경 후 반드시 \`npm run build\` (있으면 \`npm test\`)를 실행해 통과시킨다.
- git commit / push / PR 생성은 하지 않는다. 파이프라인이 대신 한다.
- 비밀값(.env, 토큰)을 코드에 쓰지 않는다. 필요한 환경변수는 README의 환경변수 표에 추가한다.
- 마지막 응답은 Slack에 그대로 올라간다. 한국어로 3~6줄: 무엇을 바꿨는지, 확인 방법, 남은 질문.`;

/**
 * Claude Agent SDK(= Claude Code 하네스)로 cwd의 레포를 수정한다.
 * cwd는 이 작업만을 위한 클론이라 다른 레포·홈 디렉터리와 분리된다.
 */
export async function runCodingAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  let summary = "";
  let costUsd = 0;
  let turns = 0;
  let ok = false;

  const stream = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      // 레포의 CLAUDE.md / .claude 설정을 읽는다 (앱별 규칙을 레포에 둘 수 있게)
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
      // 파일 수정과 빌드/테스트 실행은 사람 확인 없이 허용. 배포·머지는 Slack 버튼으로만.
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "TodoWrite"],
      disallowedTools: ["Bash(git push:*)", "Bash(gh:*)", "Bash(vercel:*)", "Bash(aws:*)", "Bash(terraform:*)"],
      maxTurns: 150,
      maxBudgetUsd: opts.maxBudgetUsd,
    },
  });

  for await (const msg of stream as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && opts.onProgress) {
          opts.onProgress(describeTool(block.name, block.input as Record<string, unknown>));
        }
      }
    } else if (msg.type === "result") {
      costUsd = msg.total_cost_usd;
      turns = msg.num_turns;
      if (msg.subtype === "success") {
        ok = !msg.is_error;
        summary = msg.result;
      } else {
        summary = `에이전트가 작업을 끝내지 못했어요 (${msg.subtype}).`;
      }
    }
  }
  return { ok, summary, costUsd, turns };
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? "").slice(0, 80);
  switch (name) {
    case "Edit":
    case "Write":
      return `✏️ ${s(input.file_path)}`;
    case "Bash":
      return `▶️ \`${s(input.command)}\``;
    case "Read":
      return `👀 ${s(input.file_path)}`;
    default:
      return `🔧 ${name}`;
  }
}
