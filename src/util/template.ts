import { appendFile, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TEMPLATE_DIR = new URL("../../templates/app/", import.meta.url).pathname;
/** 앱인토스(토스 미니앱)로도 내는 앱에 덧씌우는 파일 */
export const TOSS_TEMPLATE_DIR = new URL("../../templates/toss/", import.meta.url).pathname;
/** 템플릿이 넣는 앱인토스 SDK 버전 (ait deploy 는 1.4.0 이상 필요) */
export const APPS_IN_TOSS_SDK_VERSION = "^3.11.0";

export type TemplateVars = Record<string, string>;

export function render(text: string, vars: TemplateVars): string {
  return text.replace(/__([A-Z0-9_]+)__/g, (m, key: string) => (key in vars ? vars[key] : m));
}

/** 템플릿을 dest로 복사하고 __KEY__ 자리표시자를 채운다. */
export async function renderTemplate(
  dest: string,
  vars: TemplateVars,
  { withBackend, withToss = false }: { withBackend: boolean; withToss?: boolean },
): Promise<void> {
  await cp(TEMPLATE_DIR, dest, { recursive: true });
  if (withToss) await addTossOverlay(dest);
  if (!withBackend) {
    for (const p of ["backend", "infra", ".github/workflows/backend.yml"]) {
      await rm(join(dest, p), { recursive: true, force: true });
    }
  }
  for (const file of await walk(dest)) {
    const text = await readFile(file, "utf8");
    const out = render(text, vars);
    if (out !== text) await writeFile(file, out);
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/**
 * 앱인토스 미니앱용 파일을 얹는다: apps-in-toss.config.ts, 정적 내보내기 next.config.ts,
 * docs/apps-in-toss.md, package.json 의 build:ait 스크립트와 SDK 의존성, CLAUDE.md/README 안내.
 */
async function addTossOverlay(dest: string): Promise<void> {
  await cp(join(TOSS_TEMPLATE_DIR, "web"), join(dest, "web"), { recursive: true });
  await cp(join(TOSS_TEMPLATE_DIR, "docs"), join(dest, "docs"), { recursive: true });
  await appendFile(join(dest, "CLAUDE.md"), await readFile(join(TOSS_TEMPLATE_DIR, "CLAUDE.toss.md"), "utf8"));
  await appendFile(join(dest, "README.md"), await readFile(join(TOSS_TEMPLATE_DIR, "README.toss.md"), "utf8"));

  const pkgPath = join(dest, "web/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.scripts = { ...pkg.scripts, "build:ait": "AIT_EXPORT=1 next build && ait build" };
  pkg.dependencies = { ...pkg.dependencies, "@apps-in-toss/web-framework": APPS_IN_TOSS_SDK_VERSION };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const ignore = join(dest, ".gitignore");
  await appendFile(ignore, "\n# 앱인토스 번들\n*.ait\nweb/out/\n");
}
