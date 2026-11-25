import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 셸을 거치지 않고 명령을 실행한다(인자 주입 방지). 실패 시 throw. */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; allowFail?: boolean; redact?: string[] } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !opts.allowFail) {
        let shown = `${cmd} ${args.join(" ")}`;
        let err = stderr;
        for (const secret of opts.redact ?? []) {
          shown = shown.split(secret).join("***");
          err = err.split(secret).join("***");
        }
        reject(new Error(`명령 실패 (${result.code}): ${shown}\n${err.slice(-2000)}`));
      } else resolve(result);
    });
  });
}
