import { describe, expect, it } from "vitest";
import { describeError } from "../src/util/errors.js";

describe("describeError", () => {
  it("Octokit 오류의 상태·응답·필요 권한을 보여준다", () => {
    const err = Object.assign(new Error("Resource not accessible by personal access token"), {
      name: "HttpError",
      status: 403,
      request: { method: "POST", url: "https://api.github.com/user/repos" },
      response: {
        data: { message: "Resource not accessible by personal access token" },
        headers: { "x-accepted-github-permissions": "administration=write" },
      },
    });
    const out = describeError(err);
    expect(out).toContain("HttpError 403");
    expect(out).toContain("POST https://api.github.com/user/repos");
    expect(out).toContain("administration=write");
  });
  it("일반 값도 문자열로", () => expect(describeError("x")).toBe("x"));
});
