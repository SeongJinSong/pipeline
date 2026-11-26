import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnv, findTossProject, parseScheme, publicOnly, uploadHint } from "../src/integrations/appsintoss.js";
import { agentEnv, DISALLOWED_TOOLS } from "../src/integrations/agent.js";

describe("앱인토스", () => {
  it("ait deploy --scheme-only 출력에서 테스트 스킴을 꺼낸다", () => {
    const out = "intoss-private://run-crew?_deploymentId=01a216b2-3e75-7e12-a495-f67b6d707307&host=appsInTossHost\n";
    expect(parseScheme(out)).toEqual({
      scheme: "intoss-private://run-crew?_deploymentId=01a216b2-3e75-7e12-a495-f67b6d707307&host=appsInTossHost",
      appName: "run-crew",
      deploymentId: "01a216b2-3e75-7e12-a495-f67b6d707307",
    });
    expect(parseScheme("fetch failed")).toBeNull();
  });

  it("apps-in-toss.config 가 있는 package 루트(레포 루트 또는 web/)를 미니앱으로 본다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ait-"));
    expect(findTossProject(root)).toBeNull();
    await mkdir(join(root, "web"));
    await writeFile(join(root, "web/package.json"), "{}");
    expect(findTossProject(root)).toBeNull();
    await writeFile(join(root, "web/apps-in-toss.config.ts"), "export default {}");
    expect(findTossProject(root)).toBe(join(root, "web"));
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "apps-in-toss.config.mjs"), "export default {}");
    expect(findTossProject(root)).toBe(root);
  });

  it("빌드 환경에는 봇 비밀값을 넘기지 않는다", () => {
    const saved = { ...process.env };
    process.env.GITHUB_TOKEN = "gh-secret";
    process.env.APPS_IN_TOSS_API_KEY = "ait-secret";
    process.env.SLACK_BOT_TOKEN = "xoxb-secret";
    try {
      const env = buildEnv("/tmp/h");
      expect(env.HOME).toBe("/tmp/h");
      expect(env.PATH).toBe(process.env.PATH);
      expect(JSON.stringify(env)).not.toMatch(/secret/);
    } finally {
      process.env = saved;
    }
  });

  it("정적 빌드에는 NEXT_PUBLIC_* 공개값만 넣는다", () => {
    expect(publicOnly({ NEXT_PUBLIC_API_URL: "u", DATABASE_URL: "secret" })).toEqual({ NEXT_PUBLIC_API_URL: "u" });
  });

  it("앱 미등록·키 문제에는 할 일을 덧붙인다", () => {
    expect(uploadHint("404 Not Found")).toContain("appName 으로 앱이 등록돼");
    expect(uploadHint("401 Unauthorized")).toContain("APPS_IN_TOSS_API_KEY");
    expect(uploadHint("boom")).toBe("boom");
  });

  it("에이전트는 봇 비밀값을 못 받고 ait deploy 를 못 쓴다", () => {
    const env = agentEnv(
      { PATH: "/bin", GITHUB_TOKEN: "x", APPS_IN_TOSS_API_KEY: "y", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o" },
      { keepApiKey: false },
    );
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "o" });
    expect(agentEnv({ ANTHROPIC_API_KEY: "k" }, { keepApiKey: true }).ANTHROPIC_API_KEY).toBe("k");
    expect(DISALLOWED_TOOLS).toContain("Bash(npx ait deploy:*)");
  });
});
