import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TEMPLATE_DIR = new URL("../../templates/app/", import.meta.url).pathname;

export type TemplateVars = Record<string, string>;

export function render(text: string, vars: TemplateVars): string {
  return text.replace(/__([A-Z0-9_]+)__/g, (m, key: string) => (key in vars ? vars[key] : m));
}

/** 템플릿을 dest로 복사하고 __KEY__ 자리표시자를 채운다. */
export async function renderTemplate(
  dest: string,
  vars: TemplateVars,
  { withBackend }: { withBackend: boolean },
): Promise<void> {
  await cp(TEMPLATE_DIR, dest, { recursive: true });
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
