import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../util/exec.js";

/**
 * 앱인토스(토스 미니앱) 번들 빌드·업로드.
 *
 * 레포 루트나 web/ 에 apps-in-toss.config.(ts|js|mjs) 가 있으면 미니앱으로 본다 (새 앱이든 /connectapp 으로
 * 연결한 기존 레포든 같다). 업로드는 공식 CLI `ait deploy --api-key` 로 한다. 업로드만으로는 사용자에게
 * 나가지 않고, 콘솔에서 테스트 → 검토 요청 → 승인 → 출시를 사람이 눌러야 한다.
 * https://developers-apps-in-toss.toss.im/guide/operation/toss.md
 */

export const APPS_IN_TOSS_CONSOLE_URL = "https://apps-in-toss.toss.im";
const CONFIG_FILES = ["apps-in-toss.config.ts", "apps-in-toss.config.mts", "apps-in-toss.config.js", "apps-in-toss.config.mjs"];

export interface TossUploadResult {
  appName: string;
  deploymentId: string;
  /** 토스 앱에서 열리는 테스트 스킴 (워크스페이스 멤버만) */
  scheme: string;
}

export interface AppsInTossClient {
  /** 미니앱 프로젝트 폴더 (apps-in-toss.config 가 있는 package 루트). 없으면 null */
  findProject(repoDir: string): string | null;
  /** 번들을 빌드해 콘솔에 올린다. 키가 없으면 호출하지 않는다 (enabled 확인) */
  /** publicEnv: 정적 빌드에 넣을 NEXT_PUBLIC_* 값 (비밀값을 넣지 않는다) */
  buildAndUpload(projectDir: string, memo: string, publicEnv?: Record<string, string>): Promise<TossUploadResult>;
  readonly enabled: boolean;
}

export function findTossProject(repoDir: string): string | null {
  for (const dir of [repoDir, join(repoDir, "web")]) {
    if (!existsSync(join(dir, "package.json"))) continue;
    if (CONFIG_FILES.some((f) => existsSync(join(dir, f)))) return dir;
  }
  return null;
}

/** `ait deploy --scheme-only` 출력에서 테스트 스킴을 꺼낸다 */
export function parseScheme(output: string): TossUploadResult | null {
  const m = output.match(/intoss-private:\/\/([a-z0-9-]+)\?_deploymentId=([0-9a-f-]+)\S*/i);
  if (!m) return null;
  return { scheme: m[0], appName: m[1], deploymentId: m[2] };
}

/**
 * 빌드·업로드 명령에 넘길 최소 환경. 빌드는 레포 코드(에이전트가 고친 코드·npm 스크립트)를 실행하므로
 * 봇의 Slack/GitHub/Vercel 토큰과 앱인토스 키가 든 process.env 를 그대로 넘기지 않는다.
 */
export function buildEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, CI: "1", NEXT_TELEMETRY_DISABLED: "1", AIT_LANG: "ko" };
  for (const k of ["PATH", "LANG", "TZ", "NODE_OPTIONS", "npm_config_cache", "NPM_CONFIG_CACHE"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // npm 캐시는 봇 사용자 HOME 의 것을 같이 쓴다 (매번 새로 받지 않게)
  if (!env.npm_config_cache && process.env.HOME) env.npm_config_cache = join(process.env.HOME, ".npm");
  return { ...env, ...extra };
}

export class AppsInToss implements AppsInTossClient {
  constructor(private apiKey: string | undefined) {}

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  findProject(repoDir: string): string | null {
    return findTossProject(repoDir);
  }

  async buildAndUpload(projectDir: string, memo: string, publicEnv: Record<string, string> = {}): Promise<TossUploadResult> {
    if (!this.apiKey) throw new Error("APPS_IN_TOSS_API_KEY 가 없어 앱인토스에 올릴 수 없어요.");
    // 빈 HOME: ~/.ait/credentials 에 저장된 다른 토큰이 --api-key 보다 먼저 쓰이는 걸 막고, 키가 디스크에 남지 않게
    const home = await mkdtemp(join(tmpdir(), "ait-home-"));
    try {
      const env = buildEnv(home, publicOnly(publicEnv));
      const redact = [this.apiKey];
      const ci = existsSync(join(projectDir, "package-lock.json")) ? "ci" : "install";
      await exec("npm", [ci, "--no-audit", "--no-fund"], { cwd: projectDir, env, redact });

      const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const f of await readdir(projectDir)) if (f.endsWith(".ait")) await rm(join(projectDir, f));
      if (pkg.scripts?.["build:ait"]) {
        await exec("npm", ["run", "build:ait"], { cwd: projectDir, env, redact });
      } else {
        // `ait init` 으로 붙인 기존 레포는 build 스크립트 끝에 `&& ait build` 가 붙어 있다
        await exec("npm", ["run", "build"], { cwd: projectDir, env, redact });
        if (!(await readdir(projectDir)).some((f) => f.endsWith(".ait"))) {
          await exec("npx", ["--no-install", "ait", "build"], { cwd: projectDir, env, redact });
        }
      }
      const artifact = (await readdir(projectDir)).find((f) => f.endsWith(".ait"));
      if (!artifact) throw new Error("빌드는 끝났지만 .ait 번들이 만들어지지 않았어요.");

      const res = await exec(
        "npx",
        [
          "--no-install",
          "ait",
          "deploy",
          "--scheme-only",
          "--location",
          join(projectDir, artifact),
          "--api-key",
          this.apiKey,
          "-m",
          memo.slice(0, 1000),
        ],
        { cwd: projectDir, env, redact, allowFail: true },
      );
      const out = `${res.stdout}\n${res.stderr}`.split(this.apiKey).join("***");
      const parsed = res.code === 0 ? parseScheme(out) : null;
      if (!parsed) throw new Error(`앱인토스 업로드 실패: ${uploadHint(out.trim().slice(-800))}`);
      return parsed;
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** 자주 나는 실패에 사람이 할 일을 덧붙인다 */
export function uploadHint(message: string): string {
  if (/not\s*found|존재하지|찾을 수 없|404/i.test(message)) {
    return `${message}\n→ 콘솔(${APPS_IN_TOSS_CONSOLE_URL})에 이 appName 으로 앱이 등록돼 있는지, API 키가 이 앱에 권한이 있는지 확인해 주세요.`;
  }
  if (/401|403|unauthori|forbidden|권한|인증/i.test(message)) {
    return `${message}\n→ 서버의 APPS_IN_TOSS_API_KEY 가 맞는지, 만료되거나 이 앱 권한이 빠지지 않았는지 콘솔 '키' 메뉴에서 확인해 주세요.`;
  }
  return message;
}

/** NEXT_PUBLIC_ 로 시작하는 값만 남긴다 (빌드 결과에 그대로 박히는 공개값) */
export function publicOnly(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("NEXT_PUBLIC_")));
}
