import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface AgentRunResult {
  ok: boolean;
  summary: string;
  costUsd: number;
  turns: number;
}

/**
 * 코드 수정을 어디서 돌릴지.
 * - "claude-cli": 이 머신에 로그인된 Claude Code(`claude` CLI, 구독 요금제)를 그대로 쓴다. API 토큰 과금 없음.
 * - "sdk":        Claude Agent SDK + ANTHROPIC_API_KEY (API 종량제). 서버에서 돌릴 때.
 */
export type AgentRunner = "claude-cli" | "sdk";

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  /** sdk 러너에서만 적용되는 작업당 비용 상한(USD) */
  maxBudgetUsd: number;
  runner?: AgentRunner;
  /** claude-cli 러너가 실행할 바이너리 (기본 "claude") */
  claudeBin?: string;
  /** 진행 상황을 Slack 스레드에 흘려보내기 위한 콜백 (도구 사용 요약) */
  onProgress?: (line: string) => void;
}

export const SYSTEM_APPEND = `
너는 Slack 채널에서 요구사항을 받아 이 레포의 코드를 직접 고치는 엔지니어다.
- 요구사항을 만족하는 최소한의 변경을 한다. 관련 없는 리팩터링은 하지 않는다.
- 변경 후 반드시 \`npm run build\` (있으면 \`npm test\`)를 실행해 통과시킨다.
- git commit / push / PR 생성은 하지 않는다. 파이프라인이 대신 한다.
- 비밀값(.env, 토큰)을 코드에 쓰지 않는다. 필요한 환경변수는 README의 환경변수 표에 추가한다.
- 마지막 응답은 Slack에 그대로 올라간다. 한국어로 3~6줄: 무엇을 바꿨는지, 확인 방법, 남은 질문.`;

export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "TodoWrite"];
export const DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  "Bash(gh:*)",
  "Bash(vercel:*)",
  "Bash(aws:*)",
  "Bash(terraform:*)",
];
const MAX_TURNS = 150;

/** cwd(작업 전용 클론)의 레포를 Claude로 수정한다. */
export function runCodingAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  return (opts.runner ?? "claude-cli") === "sdk" ? runWithSdk(opts) : runWithClaudeCli(opts);
}

/** 스트림 메시지(SDK와 `claude -p --output-format stream-json`이 같은 모양)를 모아 결과로 만든다. */
export class AgentStreamCollector {
  result: AgentRunResult = { ok: false, summary: "", costUsd: 0, turns: 0 };
  private gotResult = false;

  constructor(private onProgress?: (line: string) => void) {}

  push(msg: { type?: string; [k: string]: unknown }): void {
    if (msg.type === "assistant") {
      const content = (msg.message as { content?: Array<{ type: string; name?: string; input?: unknown }> })?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use" && this.onProgress) {
          this.onProgress(describeTool(block.name ?? "", (block.input ?? {}) as Record<string, unknown>));
        }
      }
    } else if (msg.type === "result") {
      this.gotResult = true;
      this.result.costUsd = Number(msg.total_cost_usd ?? 0);
      this.result.turns = Number(msg.num_turns ?? 0);
      if (msg.subtype === "success") {
        this.result.ok = !msg.is_error;
        this.result.summary = String(msg.result ?? "");
      } else {
        this.result.ok = false;
        this.result.summary = `에이전트가 작업을 끝내지 못했어요 (${String(msg.subtype)}).`;
      }
    }
  }

  finish(fallbackError?: string): AgentRunResult {
    if (!this.gotResult) {
      this.result.ok = false;
      this.result.summary = fallbackError || "에이전트가 결과 없이 종료됐어요.";
    }
    return this.result;
  }
}

async function runWithSdk(opts: AgentRunOptions): Promise<AgentRunResult> {
  const collector = new AgentStreamCollector(opts.onProgress);
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
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      maxTurns: MAX_TURNS,
      maxBudgetUsd: opts.maxBudgetUsd,
    },
  });
  for await (const msg of stream as AsyncIterable<SDKMessage>) collector.push(msg as never);
  return collector.finish();
}

/** `claude -p` 에 넘길 인자. 테스트에서 검증할 수 있게 분리. */
export function claudeCliArgs(opts: Pick<AgentRunOptions, "prompt" | "model">): string[] {
  return [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
    "--max-turns",
    String(MAX_TURNS),
    "--setting-sources",
    "project",
    "--append-system-prompt",
    SYSTEM_APPEND,
  ];
}

/**
 * 로컬에 로그인된 Claude Code로 실행한다.
 * API 키가 환경변수에 있으면 CLI가 키(종량제)를 우선 쓰므로, 자식 프로세스에서는 지운다 → 구독 로그인 사용.
 */
function runWithClaudeCli(opts: AgentRunOptions): Promise<AgentRunResult> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn(opts.claudeBin ?? "claude", claudeCliArgs(opts), {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collector = new AgentStreamCollector(opts.onProgress);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        collector.push(JSON.parse(line));
      } catch {
        // stream-json 이 아닌 줄은 무시
      }
    });
    child.on("error", (err) =>
      reject(
        new Error(
          `claude CLI 를 실행하지 못했어요 (${err.message}). 이 머신에 Claude Code 가 설치·로그인돼 있는지 확인하세요: \`claude\` 실행 후 /login`,
        ),
      ),
    );
    child.on("close", (code) => {
      lines.close();
      const hint = code !== 0 ? `claude CLI 종료 코드 ${code}.\n${stderr.slice(-1500)}` : undefined;
      resolve(collector.finish(hint));
    });
  });
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
