/**
 * 앱 이름 → 레포/채널/Vercel 프로젝트에 공통으로 쓸 수 있는 slug.
 * Slack 채널 이름 규칙(소문자, 숫자, -, _ / 최대 80자)과 GitHub·Vercel 규칙을 동시에 만족시킨다.
 */
export function toSlug(input: string, maxLen = 40): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || `app-${Date.now().toString(36)}`;
}

export function channelName(prefix: string, slug: string): string {
  return `${prefix}${slug}`.slice(0, 80);
}

/** 변경 요청 → git 브랜치 이름 */
export function branchName(changeId: number, request: string): string {
  const words = toSlug(request, 30);
  return `pipeline/${changeId}-${words.startsWith("app-") ? "change" : words}`;
}
