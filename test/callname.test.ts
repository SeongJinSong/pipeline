import { describe, expect, it } from "vitest";
import { parseCallName } from "../src/slack/app.js";

describe("parseCallName", () => {
  const names = ["파피"];
  it("한글 호출 이름으로 시작하면 나머지를 요청으로 본다", () => {
    expect(parseCallName("@파피 토스 콘솔 앱 상태 알려줘", names)).toBe("토스 콘솔 앱 상태 알려줘");
    expect(parseCallName("파피야 로그인 페이지 추가해줘", names)).toBe("로그인 페이지 추가해줘");
    expect(parseCallName("파피, 버튼 키워줘", names)).toBe("버튼 키워줘");
    expect(parseCallName("  @파피\n두 줄 요청", names)).toBe("두 줄 요청");
    expect(parseCallName("@파피", names)).toBe("");
  });

  it("다른 말로 시작하거나 이름의 일부면 무시한다", () => {
    expect(parseCallName("오늘 파피 불러볼까", names)).toBeNull();
    expect(parseCallName("파피용 만들자", names)).toBeNull();
    expect(parseCallName("파피루스 얘기", names)).toBeNull();
    expect(parseCallName("@파피 해줘", [])).toBeNull();
  });

  it("이름을 여러 개 둘 수 있다", () => {
    expect(parseCallName("개발자야 고쳐줘", ["파피", "개발자"])).toBe("고쳐줘");
  });
});
