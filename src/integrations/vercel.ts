/**
 * Vercel REST API 최소 클라이언트.
 * 전제: Vercel 계정(또는 팀)에 GitHub 연동(Vercel GitHub App)이 설치되어 있어야
 * gitRepository로 프로젝트를 만들 수 있고, 이후 push/PR마다 자동 배포된다.
 */
export interface VercelDeployment {
  uid: string;
  url: string;
  state?: string; // BUILDING | READY | ERROR | CANCELED | QUEUED
  readyState?: string;
  target?: string | null;
  meta?: Record<string, string>;
}

export class Vercel {
  constructor(
    private token: string,
    private teamId?: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(`https://api.vercel.com${path}`);
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vercel ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createProject(name: string, repoFullName: string): Promise<{ id: string; name: string }> {
    return this.call("POST", "/v11/projects", {
      name,
      framework: "nextjs",
      rootDirectory: "web",
      gitRepository: { type: "github", repo: repoFullName },
    });
  }

  /** 프로젝트 삭제. 이미 없으면 false. */
  async deleteProject(idOrName: string): Promise<boolean> {
    try {
      await this.call("DELETE", `/v9/projects/${encodeURIComponent(idOrName)}`);
      return true;
    } catch (err) {
      if (String(err).includes("→ 404")) return false;
      throw err;
    }
  }

  async upsertEnv(
    projectId: string,
    key: string,
    value: string,
    targets: Array<"production" | "preview" | "development"> = ["production", "preview"],
    type: "plain" | "encrypted" | "sensitive" = "encrypted",
  ): Promise<void> {
    const url = `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`;
    await this.call("POST", url, { key, value, target: targets, type });
  }

  async listDeployments(projectId: string, limit = 20): Promise<VercelDeployment[]> {
    const q = new URLSearchParams({ projectId, limit: String(limit) });
    const data = await this.call<{ deployments: VercelDeployment[] }>("GET", `/v6/deployments?${q}`);
    return data.deployments;
  }

  /**
   * 특정 커밋의 배포가 READY가 될 때까지 기다린다.
   * 반환값은 https:// 를 붙인 URL. 시간 초과·실패 시 null.
   */
  async waitForCommit(
    projectId: string,
    sha: string,
    { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {},
  ): Promise<{ url: string; state: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const deps = await this.listDeployments(projectId);
      const d = deps.find((x) => x.meta?.githubCommitSha === sha);
      const state = d?.state ?? d?.readyState;
      if (d && state === "READY") return { url: `https://${d.url}`, state };
      if (d && (state === "ERROR" || state === "CANCELED")) return { url: `https://${d.url}`, state };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  async productionUrl(projectName: string): Promise<string> {
    return `https://${projectName}.vercel.app`;
  }
}
