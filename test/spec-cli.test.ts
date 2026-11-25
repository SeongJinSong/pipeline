import { describe, expect, it } from "vitest";
import { parseSpecCliOutput, specCliArgs } from "../src/integrations/claude.js";

const spec = {
  name: "러닝크루",
  slug: "run-crew",
  one_liner: "동네 러닝 크루 모집",
  target_users: "러너",
  core_features: ["크루 검색"],
  pages: [{ path: "/", purpose: "홈" }],
  needs_backend: false,
  data_model: [],
  open_questions: [],
};

describe("로컬 Claude Code 로 스펙 정리", () => {
  it("structured_output 을 검증해서 돌려준다", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: spec });
    expect(parseSpecCliOutput(out)).toEqual(spec);
  });
  it("structured_output 이 없으면 result 텍스트의 JSON 을 쓴다", () => {
    const out = JSON.stringify({ is_error: false, result: "스펙입니다\n" + JSON.stringify(spec) });
    expect(parseSpecCliOutput(out).slug).toBe("run-crew");
  });
  it("형식이 틀리면 에러", () => {
    const out = JSON.stringify({ is_error: false, structured_output: { name: "x" } });
    expect(() => parseSpecCliOutput(out)).toThrow("형식");
  });
  it("CLI 에러는 그대로 보고", () => {
    expect(() => parseSpecCliOutput(JSON.stringify({ is_error: true, subtype: "error", result: "rate limited" }))).toThrow(
      "rate limited",
    );
  });
  it("도구 없이, $schema 키 없는 스키마로 호출", () => {
    const args = specCliArgs("claude-opus-5-5", "아이디어");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toContain("needs_backend");
  });
});
