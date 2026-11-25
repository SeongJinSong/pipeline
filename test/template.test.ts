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
