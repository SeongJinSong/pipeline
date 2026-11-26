import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Deps, Notifier } from "../src/flows/context.js";
import { _pendingOps, cancelConsoleOp, handleConsoleRequest, parseConsoleRequest, runConsoleOp } from "../src/flows/tossops.js";
import { claudeCliArgs } from "../src/integrations/agent.js";
import {
  consoleArgs,
  isReadTool,
  lastJson,
  parsePlan,
  TossConsole,
  type ConsoleAction,
  type ConsolePlan,
  type TossConsoleClient,
} from "../src/integrations/tossconsole.js";
import { SerialQueue } from "../src/util/serial.js";

const TOOLS = [
  "workspace_overview",
  "miniapp_list_overview",
  "miniapp_meta_status",
  "bundle_list",
  "bundle_build_status",
  "bundle_get_live_version",
  "miniapp_release_status",
  "miniapp_create",
  "bundle_upload",
  "bundle_upload_complete",
  "bundle_submit_review",
  "bundle_test_push",
  "bundle_rollback",
  "review_cancel",
  "image_upload_url",
  "event_something",
];

describe("isReadTool", () => {
  it("조회 도구만 바로 쓰고, 바뀌거나 모르는 도구는 확인을 거친다", () => {
    const read = TOOLS.filter(isReadTool);
    expect(read).toEqual([
      "workspace_overview",
      "miniapp_list_overview",
      "miniapp_meta_status",
      "bundle_list",
      "bundle_build_status",
      "bundle_get_live_version",
      "miniapp_release_status",
    ]);
    expect(isReadTool("mcp__apps-in-toss-console__bundle_list")).toBe(true);
    expect(isReadTool("mcp__apps-in-toss-console__bundle_submit_review")).toBe(false);
  });
});

describe("parsePlan", () => {
  it("마지막 JSON 블록에서 바뀌는 작업만 꺼내고 답에서 블록을 뺀다", () => {
    const text = [
      "카페인 아웃 v4 를 검토 요청하려 해요.",
      "```json",
      JSON.stringify({
        actions: [
          { tool: "mcp__apps-in-toss-console__bundle_submit_review", summary: "카페인 아웃 v4 검토 요청" },
          { tool: "bundle_list", summary: "조회는 빠진다" },
          { tool: "rm -rf /", summary: "이름이 이상하면 빠진다" },
          { tool: "unknown_tool_create", summary: "서버에 없는 도구는 빠진다" },
        ],
      }),
      "```",
    ].join("\n");
    const plan = parsePlan(text, new Set(TOOLS));
    expect(plan.answer).toBe("카페인 아웃 v4 를 검토 요청하려 해요.");
    expect(plan.actions).toEqual([{ tool: "bundle_submit_review", summary: "카페인 아웃 v4 검토 요청" }]);
  });

  it("JSON 이 없거나 깨지면 조회 답으로 본다", () => {
    expect(parsePlan("앱 5개가 있어요.").actions).toEqual([]);
    expect(parsePlan("답\n```json\n{oops\n```").actions).toEqual([]);
  });
});

describe("consoleArgs / claudeCliArgs", () => {
  it("콘솔 에이전트는 내장 도구를 끄고 허용한 MCP 도구만 묻지 않고 쓴다", () => {
    const args = consoleArgs("요청", "m", ["mcp__apps-in-toss-console__bundle_list"]);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__apps-in-toss-console__bundle_list");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("코드 수정 에이전트는 서버의 MCP(콘솔 포함)를 못 쓴다", () => {
    expect(claudeCliArgs({ prompt: "p", model: "m" })).toContain("--strict-mcp-config");
  });
});

describe("lastJson", () => {
  it("마지막 JSON 한 줄을 꺼낸다", () => {
    expect(lastJson<{ a: number }>('설명\n{"a": 1}\n끝 {"a": 2}')).toEqual({ a: 2 });
    expect(lastJson("없음")).toBeNull();
  });
});

describe("TossConsole", () => {
  it("계획 단계는 조회 도구만, 실행 단계는 승인한 도구만 연다", async () => {
    const calls: string[][] = [];
    const c = new TossConsole({
      enabled: true,
      model: "m",
      listTools: async () => TOOLS,
      run: async (args) => {
        calls.push(args);
        return calls.length === 1
          ? { ok: true, summary: '할게요\n```json\n{"actions":[{"tool":"bundle_submit_review","summary":"v4 검토 요청"}]}\n```', costUsd: 0, turns: 1 }
          : { ok: true, summary: "검토 요청했어요.", costUsd: 0, turns: 1 };
      },
    });
    const plan = await c.plan("v4 검토 요청", "ctx");
    const planAllowed = calls[0][calls[0].indexOf("--allowedTools") + 1].split(",");
    expect(planAllowed.every((t) => isReadTool(t))).toBe(true);
    expect(planAllowed).not.toContain("mcp__apps-in-toss-console__bundle_submit_review");

    expect(await c.execute("v4 검토 요청", "ctx", plan.actions)).toBe("검토 요청했어요.");
    const execAllowed = calls[1][calls[1].indexOf("--allowedTools") + 1].split(",");
    expect(execAllowed).toContain("mcp__apps-in-toss-console__bundle_submit_review");
    expect(execAllowed).not.toContain("mcp__apps-in-toss-console__bundle_rollback");
    expect(execAllowed).not.toContain("mcp__apps-in-toss-console__miniapp_create");
  });

  it("번들은 업로드 주소를 받아 봇이 PUT 하고, 완료를 알린 뒤 테스트 스킴을 돌려준다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ait-"));
    const file = join(dir, "x.ait");
    await writeFile(file, "bundle");
    const calls: string[][] = [];
    const puts: Array<[string, string]> = [];
    const c = new TossConsole({
      enabled: true,
      model: "m",
      listTools: async () => TOOLS,
      put: async (url, f) => void puts.push([url, f]),
      run: async (args) => {
        calls.push(args);
        return calls.length === 1
          ? { ok: true, summary: '찾았어요\n{"workspaceId": 82195, "miniAppId": 67399, "uploadUrl": "https://upload.example/x"}', costUsd: 0, turns: 1 }
          : { ok: true, summary: '{"ok": true, "status": "PREPARED", "reason": ""}', costUsd: 0, turns: 1 };
      },
    });
    const r = await c.uploadBundle({
      file,
      appName: "caffeine-out",
      deploymentId: "01a2",
      env: {},
      cleanup: async () => undefined,
    });
    expect(puts).toEqual([["https://upload.example/x", file]]);
    expect(r.scheme).toBe("intoss-private://caffeine-out?_deploymentId=01a2&host=appsInTossHost");
    const first = calls[0][calls[0].indexOf("--allowedTools") + 1];
    expect(first).toContain("bundle_upload");
    expect(first).not.toContain("bundle_upload_complete");
    expect(calls[1][calls[1].indexOf("--allowedTools") + 1]).toContain("bundle_upload_complete");
  });

  it("업로드 주소를 못 받으면 PUT 하지 않고 실패한다", async () => {
    const puts: string[] = [];
    const c = new TossConsole({
      enabled: true,
      model: "m",
      listTools: async () => TOOLS,
      put: async (url) => void puts.push(url),
      run: async () => ({ ok: true, summary: "이 appName 의 앱이 없어요.", costUsd: 0, turns: 1 }),
    });
    await expect(
      c.uploadBundle({ file: "/nope", appName: "none", deploymentId: "1", env: {}, cleanup: async () => undefined }),
    ).rejects.toThrow(/업로드 주소/);
    expect(puts).toEqual([]);
  });
});

describe("parseConsoleRequest", () => {
  it("콘솔 접두어만 콘솔 작업으로 본다", () => {
    expect(parseConsoleRequest("콘솔 앱 상태 알려줘")).toBe("앱 상태 알려줘");
    expect(parseConsoleRequest("앱인토스 콘솔: 반려 사유")).toBe("반려 사유");
    expect(parseConsoleRequest("toss console status")).toBe("status");
    expect(parseConsoleRequest("콘솔")).toBe("");
    expect(parseConsoleRequest("토스 로그인 붙여줘")).toBeNull();
    expect(parseConsoleRequest("콘솔로그 지워줘")).toBeNull();
  });
});

function fakeDeps(console_: TossConsoleClient) {
  const posts: Array<{ text: string; threadTs?: string; blocks?: unknown[] }> = [];
  let n = 0;
  const notifier: Notifier = {
    async post(_c, text, opts = {}) {
      posts.push({ text, ...opts });
      return `ts-${++n}`;
    },
    async update(_c, ts, text, blocks) {
      posts.push({ text: `[update ${ts}] ${text}`, blocks });
    },
    async createChannel() {
      return "C";
    },
    async invite() {},
    async archiveChannel() {},
  };
  const deps = { config: {} as Config, notifier, queue: new SerialQueue(), tossConsole: console_ } as unknown as Deps;
  return { deps, posts };
}

function fakeConsole(plan: ConsolePlan) {
  const executed: ConsoleAction[][] = [];
  const c: TossConsoleClient = {
    enabled: true,
    plan: async () => plan,
    execute: async (_r, _c, actions) => {
      executed.push(actions);
      return "검토 요청했어요.";
    },
    uploadBundle: async () => {
      throw new Error("unused");
    },
  };
  return { c, executed };
}

describe("handleConsoleRequest", () => {
  it("조회만이면 바로 답한다", async () => {
    const { c } = fakeConsole({ answer: "앱 5개, 모두 출시 전이에요.", actions: [] });
    const { deps, posts } = fakeDeps(c);
    await handleConsoleRequest(deps, { channel: "C1", threadTs: "t1", userId: "U1", request: "상태" });
    expect(posts.at(-1)!.text).toContain("앱 5개");
    expect(posts.at(-1)!.blocks?.length).toBe(1);
  });

  it("바뀌는 작업은 [실행]을 눌러야 하고, 한 번만 실행된다", async () => {
    const action = { tool: "bundle_submit_review", summary: "카페인 아웃 v4 검토 요청" };
    const { c, executed } = fakeConsole({ answer: "v4 를 검토 요청할게요.", actions: [action] });
    const { deps, posts } = fakeDeps(c);
    await handleConsoleRequest(deps, { channel: "C1", threadTs: "t1", userId: "U1", request: "v4 검토 요청" });
    expect(executed).toEqual([]);
    const blocks = JSON.stringify(posts.at(-1)!.blocks);
    expect(blocks).toContain("toss_console_run");
    const opId = [..._pendingOps().values()].at(-1)!.id;

    await runConsoleOp(deps, opId, "U1");
    await runConsoleOp(deps, opId, "U1");
    expect(executed).toEqual([[action]]);
    expect(posts.some((p) => p.threadTs === "t1" && p.text === "검토 요청했어요.")).toBe(true);
  });

  it("취소하면 실행하지 않고, 없는 요청은 만료로 알린다", async () => {
    const { c, executed } = fakeConsole({ answer: "", actions: [{ tool: "bundle_rollback", summary: "롤백" }] });
    const { deps } = fakeDeps(c);
    await handleConsoleRequest(deps, { channel: "C1", threadTs: "t2", userId: "U1", request: "롤백" });
    const opId = [..._pendingOps().values()].at(-1)!.id;
    await cancelConsoleOp(deps, opId, "U1");
    await expect(runConsoleOp(deps, opId, "U1")).rejects.toThrow(/만료/);
    expect(executed).toEqual([]);
  });

  it("콘솔 MCP 가 꺼져 있으면 켜는 방법을 알려 준다", async () => {
    const { deps, posts } = fakeDeps({ ...fakeConsole({ answer: "", actions: [] }).c, enabled: false });
    await handleConsoleRequest(deps, { channel: "C1", threadTs: "t3", userId: "U1", request: "상태" });
    expect(posts.at(-1)!.text).toContain("TOSS_CONSOLE_MCP");
  });
});
