import { describe, expect, it } from "vitest";
import { branchName, channelName, toSlug } from "../src/util/names.js";
import { render } from "../src/util/template.js";

describe("toSlug", () => {
  it("영문 이름을 소문자-하이픈으로", () => {
    expect(toSlug("Running Crew Finder!")).toBe("running-crew-finder");
  });
  it("길이를 자르고 끝 하이픈을 제거", () => {
    expect(toSlug("a".repeat(39) + " bcd", 40)).toBe("a".repeat(39));
  });
  it("한글만 있으면 대체 slug", () => {
    expect(toSlug("마라탕")).toMatch(/^app-[a-z0-9]+$/);
  });
});

describe("channelName / branchName", () => {
  it("접두어를 붙이고 80자 제한", () => {
    expect(channelName("app-", "x".repeat(100))).toHaveLength(80);
  });
  it("요청에서 브랜치 이름", () => {
    expect(branchName(7, "Add login page")).toBe("pipeline/7-add-login-page");
    expect(branchName(8, "로그인 추가")).toBe("pipeline/8-change");
  });
});

describe("template render", () => {
  it("알려진 키만 치환", () => {
    expect(render("__APP_NAME__ / __UNKNOWN__", { APP_NAME: "X" })).toBe("X / __UNKNOWN__");
  });
});
