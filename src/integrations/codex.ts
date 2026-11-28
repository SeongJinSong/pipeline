import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv } from "./agent.js";

/**
 * 리뷰어 페르소나: OpenAI Codex CLI(`codex exec`)를 읽기 전용 샌드박스로 돌려 PR 을 리뷰한다.
 * - 파피(Claude)와 다른 프로세스·다른 모델·다른 로그인(~/.codex) → 컨텍스트가 섞이지 않는다.
 * - `--sandbox read-only`: 파일을 못 고치고 네트워크도 막힌다. 리뷰어는 코멘트만 한다.
 * - 최종 답은 JSON 스키마(--output-schema)로 받아 판정(approve / changes_requested)을 기계적으로 읽는다.
 */

export type ReviewVerdict = "approve" | "changes_requested";

export interface ReviewFinding {
  severity: "must" | "should" | "nit";
  file: string;
  line: number | null;
  issue: string;
  suggestion: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewRunOptions {
  cwd: string;
  prompt: string;
  codexBin?: string;
  model?: string;
}

export type ReviewRunner = (opts: ReviewRunOptions) => Promise<ReviewResult>;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "issue", "suggestion"],
        properties: {
          severity: { type: "string", enum: ["must", "should", "nit"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          issue: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
} as const;

/** `codex exec` 인자. 프롬프트는 stdin 으로 넘긴다 (diff 가 길어도 argv 한도에 안 걸리게) */
export function codexArgs(opts: { cwd: string; schemaPath: string; outPath: string; model?: string }): string[] {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--cd",
    opts.cwd,
    "--ephemeral",
    "--color",
    "never",
    "--output-schema",
    opts.schemaPath,
    "--output-last-message",
    opts.outPath,
  ];
  if (opts.model) args.push("--model", opts.model);
  args.push("-");
  return args;
}

/** Codex 최종 메시지(JSON)를 읽는다. 코드펜스로 감싸 오거나 앞뒤에 말이 붙어도 첫 JSON 객체를 찾는다 */
export function parseReview(raw: string): ReviewResult {
  const text = raw.trim();
  const candidates = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, "")];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as Partial<ReviewResult>;
      if (v && (v.verdict === "approve" || v.verdict === "changes_requested")) {
        return {
          verdict: v.verdict,
          summary: String(v.summary ?? ""),
          findings: Array.isArray(v.findings)
            ? v.findings.map((f) => ({
                severity: f.severity === "must" || f.severity === "nit" ? f.severity : "should",
                file: String(f.file ?? ""),
                line: typeof f.line === "number" ? f.line : null,
                issue: String(f.issue ?? ""),
                suggestion: String(f.suggestion ?? ""),
              }))
            : [],
        };
      }
    } catch {
      // 다음 후보
    }
  }
  throw new Error(`리뷰어 답을 읽지 못했어요:\n${text.slice(0, 500)}`);
}

export const runCodexReview: ReviewRunner = async (opts) => {
  const tmp = await mkdtemp(join(tmpdir(), "codex-review-"));
  const schemaPath = join(tmp, "schema.json");
  const outPath = join(tmp, "out.json");
  try {
    await writeFile(schemaPath, JSON.stringify(REVIEW_SCHEMA));
    const args = codexArgs({ cwd: opts.cwd, schemaPath, outPath, model: opts.model });
    // 봇 비밀값(Slack·GitHub·Vercel 토큰)은 넘기지 않는다. Codex 로그인은 ~/.codex 에 있다
    const env = agentEnv(process.env, { keepApiKey: false });
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(opts.codexBin ?? "codex", args, { cwd: opts.cwd, env, stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) =>
        reject(
          new Error(
            `codex CLI 를 실행하지 못했어요 (${e.message}). 서버에 Codex 가 설치·로그인돼 있는지 확인하세요: docs/REVIEWER.md`,
          ),
        ),
      );
      child.on("close", (c) => resolve({ code: c ?? 1, stderr: err }));
      child.stdin.end(opts.prompt);
    });
    const out = await readFile(outPath, "utf8").catch(() => "");
    if (!out.trim()) {
      throw new Error(`리뷰어(Codex)가 답 없이 끝났어요 (종료 코드 ${code}).\n${stderr.slice(-1500)}`);
    }
    return parseReview(out);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};
