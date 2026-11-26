import type { AppRecord } from "../store.js";
import { toSlug } from "../util/names.js";
import type { Deps } from "./context.js";

/** "owner/repo", "repo"(GITHUB_OWNER 기준), GitHub URL 을 owner/repo 로 */
export function parseRepoArg(input: string, defaultOwner: string): string | null {
  const s = input
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  const ok = (p: string) => /^[A-Za-z0-9_.-]+$/.test(p);
  if (parts.length === 1 && ok(parts[0])) return `${defaultOwner}/${parts[0]}`;
  if (parts.length >= 2 && ok(parts[0]) && ok(parts[1])) return `${parts[0]}/${parts[1]}`;
  return null;
}

export type ConnectResult =
  | { ok: true; app: AppRecord; vercel: boolean }
  | { ok: false; message: string };

/**
 * 이미 있는 GitHub 레포를 지금 Slack 채널에 연결한다 (/connectapp).
 * 이후 이 채널의 @멘션은 그 레포의 코드 수정 → PR → (프리뷰) → [배포] 로 이어진다.
 * 봇이 만든 앱이 아니므로 /deleteapp 은 연결만 끊고 레포·배포는 건드리지 않는다.
 */
export async function connectRepo(
  deps: Pick<Deps, "store" | "github" | "vercel" | "config">,
  args: { repoArg: string; channelId: string; userId: string },
): Promise<ConnectResult> {
  const { store, github, vercel, config } = deps;
  const repoName = parseRepoArg(args.repoArg, config.GITHUB_OWNER);
  if (!repoName) return { ok: false, message: "레포를 알아보지 못했어요. 예: `/connectapp mujuhoney` 또는 `/connectapp SeongJinSong/mujuhoney`" };

  const inChannel = store.getAppByChannel(args.channelId);
  if (inChannel) {
    return { ok: false, message: `이 채널은 이미 \`${inChannel.repo}\` 에 연결돼 있어요. 바꾸려면 먼저 \`/deleteapp\` 으로 연결을 끊어주세요.` };
  }
  const existing = store.getAppByRepo(repoName);
  if (existing) {
    return { ok: false, message: `\`${existing.repo}\` 는 이미 <#${existing.slack_channel_id}> 에 연결돼 있어요.` };
  }

  let info;
  try {
    info = await github.getRepo(repoName);
  } catch (err) {
    const status = (err as { status?: number }).status;
    return {
      ok: false,
      message:
        status === 404 || status === 403
          ? `\`${repoName}\` 레포를 찾을 수 없거나 봇 GitHub 토큰에 권한이 없어요. 토큰의 Repository access 에 이 레포가 포함돼 있는지 확인해주세요.`
          : `GitHub 확인 중 오류: ${String(err).slice(0, 300)}`,
    };
  }

  const project = await vercel.findProjectByRepo(info.fullName).catch(() => null);
  let slug = toSlug(info.name);
  for (let i = 2; store.getAppBySlug(slug); i++) slug = `${toSlug(info.name)}-${i}`;

  const app = store.createApp({
    slug,
    name: info.name,
    idea: info.description || "(기존 레포 연결)",
    repo: info.fullName,
    created_by: args.userId,
    connected: true,
  });
  store.updateApp(app.id, {
    slack_channel_id: args.channelId,
    vercel_project_id: project?.id ?? null,
    production_url: project?.productionUrl ?? null,
    status: "ready",
  });
  return { ok: true, app: store.getApp(app.id)!, vercel: Boolean(project) };
}
