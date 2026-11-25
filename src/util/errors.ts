/** Slack에 올릴 오류 설명. Octokit/HTTP 오류면 상태·요청·응답 메시지·필요 권한까지 보여준다. */
export function describeError(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    status?: number;
    request?: { method?: string; url?: string };
    response?: { data?: unknown; headers?: Record<string, string | undefined> };
  };
  if (!e || typeof e !== "object") return String(err);
  const lines = [`${e.name ?? "Error"}${e.status ? ` ${e.status}` : ""}: ${e.message ?? ""}`.trim()];
  if (e.request?.method && e.request.url) {
    lines.push(`${e.request.method} ${e.request.url.replace(/access_token=[^&]+/g, "access_token=***")}`);
  }
  const data = e.response?.data as { message?: string; errors?: unknown; error?: unknown } | undefined;
  if (data && typeof data === "object") {
    if (data.message) lines.push(`응답: ${data.message}`);
    if (data.errors) lines.push(`상세: ${JSON.stringify(data.errors).slice(0, 500)}`);
    if (data.error) lines.push(`상세: ${JSON.stringify(data.error).slice(0, 500)}`);
  }
  const need = e.response?.headers?.["x-accepted-github-permissions"];
  if (need) lines.push(`필요한 GitHub 권한: ${need}`);
  return lines.join("\n");
}
