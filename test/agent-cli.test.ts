import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStreamCollector, claudeCliArgs, runCodingAgent } from "../src/integrations/agent.js";

describe("claude-cli 러너", () => {
  it("구독 로그인을 쓰도록 API 키를 자식 프로세스에서 지우고, stream-json 결과를 모은다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-cli-"));
    // 가짜 claude: 인자와 환경을 기록하고 파일을 하나 고친 뒤 stream-json 을 출력
    const bin = join(dir, "fake-claude.mjs");
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("seen.json", JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY ?? null }));
writeFileSync("hello.txt", "hi");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init" });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "hello.txt" } }] } });
out({ type: "result", subtype: "success", is_error: false, result: "hello.txt 를 만들었어요", total_cost_usd: 0.42, num_turns: 2 });
`,
    );
    await chmod(bin, 0o755);
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    const progress: string[] = [];
    const result = await runCodingAgent({
      cwd: dir,
      prompt: "make hello",
      model: "claude-opus-5-5",
      maxBudgetUsd: 1,
      runner: "claude-cli",
      claudeBin: bin,
      onProgress: (l) => progress.push(l),
    });
    delete process.env.ANTHROPIC_API_KEY;

    expect(result).toEqual({ ok: true, summary: "hello.txt 를 만들었어요", costUsd: 0.42, turns: 2 });
    expect(progress).toEqual(["✏️ hello.txt"]);
    const seen = JSON.parse(await readFile(join(dir, "seen.json"), "utf8"));
    expect(seen.key).toBeNull();
    expect(seen.args).toEqual(claudeCliArgs({ prompt: "make hello", model: "claude-opus-5-5" }));
    expect(seen.args).toContain("acceptEdits");
  });

  it("CLI 가 결과 없이 죽으면 실패로 보고한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-cli-"));
    const bin = join(dir, "dead.mjs");
    await writeFile(bin, `#!/usr/bin/env node\nprocess.stderr.write("not logged in");\nprocess.exit(1);\n`);
    await chmod(bin, 0o755);
    const r = await runCodingAgent({ cwd: dir, prompt: "x", model: "m", maxBudgetUsd: 1, claudeBin: bin });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not logged in");
  });

  it("claude 가 없으면 설치·로그인 안내와 함께 실패", async () => {
    await expect(
      runCodingAgent({ cwd: tmpdir(), prompt: "x", model: "m", maxBudgetUsd: 1, claudeBin: "/nonexistent/claude" }),
    ).rejects.toThrow("/login");
  });
});

it("에러 result 는 ok=false", () => {
  const c = new AgentStreamCollector();
  c.push({ type: "result", subtype: "error_max_turns", total_cost_usd: 1, num_turns: 150 });
  expect(c.finish()).toMatchObject({ ok: false, turns: 150 });
});
