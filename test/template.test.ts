import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderTemplate } from "../src/util/template.js";

const vars = {
  APP_NAME: "러닝크루",
  APP_SLUG: "run-crew",
  APP_ONE_LINER: "동네 러닝 크루 모집",
  AWS_REGION: "ap-northeast-2",
  CHANNEL: "app-run-crew",
  PRODUCTION_URL: "https://run-crew.vercel.app",
  PROJECT_URL: "https://github.com/users/me/projects/1",
};

it("백엔드 없는 앱은 backend/infra/워크플로를 빼고 자리표시자를 채운다", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "tpl-")), "out");
  await renderTemplate(dir, vars, { withBackend: false });
  expect(existsSync(join(dir, "backend"))).toBe(false);
  expect(existsSync(join(dir, "infra"))).toBe(false);
  expect(existsSync(join(dir, ".github/workflows/backend.yml"))).toBe(false);
  const pkg = JSON.parse(await readFile(join(dir, "web/package.json"), "utf8"));
  expect(pkg.name).toBe("run-crew");
  expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toContain("#app-run-crew");
});

it("백엔드 있는 앱은 Terraform에 slug/리전이 들어간다", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "tpl-")), "out");
  await renderTemplate(dir, vars, { withBackend: true });
  const tf = await readFile(join(dir, "infra/main.tf"), "utf8");
  expect(tf).toContain('default = "run-crew"');
  expect(tf).toContain('default = "ap-northeast-2"');
  expect(tf).not.toMatch(/__[A-Z_]+__/);
});

it("이슈 템플릿·PR 템플릿·docs/plans 규칙이 모든 앱에 들어간다", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "tpl-")), "out");
  await renderTemplate(dir, vars, { withBackend: false });
  for (const f of [
    ".github/ISSUE_TEMPLATE/feature.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/pull_request_template.md",
    "docs/plans/README.md",
    "docs/plans/TEMPLATE.md",
  ]) {
    expect(existsSync(join(dir, f)), f).toBe(true);
  }
  expect(existsSync(join(dir, ".github/ISSUE_TEMPLATE"))).toBe(true); // backend.yml 만 지우고 .github 는 남는다
  expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toContain("문서가 원본이다");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  expect(readme).toContain("https://github.com/users/me/projects/1");
  expect(readme).not.toMatch(/__[A-Z_]+__/);
});

it("앱인토스 앱은 config·정적 내보내기·build:ait·운영 문서가 들어가고, 웹 앱에는 없다", async () => {
  const web = join(await mkdtemp(join(tmpdir(), "tpl-")), "out");
  await renderTemplate(web, vars, { withBackend: false });
  expect(existsSync(join(web, "web/apps-in-toss.config.ts"))).toBe(false);
  expect(existsSync(join(web, "docs/apps-in-toss.md"))).toBe(false);

  const dir = join(await mkdtemp(join(tmpdir(), "tpl-")), "out");
  await renderTemplate(dir, vars, { withBackend: false, withToss: true });
  const config = await readFile(join(dir, "web/apps-in-toss.config.ts"), "utf8");
  expect(config).toContain('appName: "run-crew"');
  expect(config).toContain('webBundleDir: "out"');
  const pkg = JSON.parse(await readFile(join(dir, "web/package.json"), "utf8"));
  expect(pkg.scripts["build:ait"]).toBe("AIT_EXPORT=1 next build && ait build");
  expect(pkg.scripts.build).toBe("next build"); // Vercel 빌드는 그대로
  expect(pkg.dependencies["@apps-in-toss/web-framework"]).toBeDefined();
  expect(await readFile(join(dir, "web/next.config.ts"), "utf8")).toContain('output: "export"');
  expect(await readFile(join(dir, "docs/apps-in-toss.md"), "utf8")).toContain("run-crew.private-apps.tossmini.com");
  expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toContain("npm run build:ait");
  expect(await readFile(join(dir, "README.md"), "utf8")).toContain("앱인토스");
  expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("*.ait");
  for (const f of ["web/apps-in-toss.config.ts", "docs/apps-in-toss.md", "CLAUDE.md", "README.md"]) {
    expect(await readFile(join(dir, f), "utf8"), f).not.toMatch(/__[A-Z_]+__/);
  }
});
