import type { AppRecord } from "../store.js";
import { describeError } from "../util/errors.js";
import type { Deps } from "./context.js";

/** `/deleteapp` 인자(슬러그, 이름, #채널 멘션)로 앱을 찾는다. */
export function findApp(deps: Pick<Deps, "store" | "config">, query: string): AppRecord | undefined {
  const q = query.trim().replace(/^#/, "");
  const channel = q.match(/^<#([A-Z0-9]+)(\|[^>]*)?>$/)?.[1];
  if (channel) return deps.store.getAppByChannel(channel);
  const apps = deps.store.listApps();
  return (
    apps.find((a) => a.slug === q) ??
    apps.find((a) => a.name === q) ??
    apps.find((a) => `${deps.config.SLACK_CHANNEL_PREFIX}${a.slug}` === q)
  );
}

/**
 * 테스트·실패한 앱 정리: GitHub 레포 삭제 → Vercel 프로젝트 삭제 → Slack 채널 보관 → 기록 삭제.
 * 한 단계가 실패해도 나머지는 진행하고, 결과를 줄별로 돌려준다.
 * AWS 리소스(Lambda 등)는 Terraform state 로 관리되므로 여기서 지우지 않는다.
 */
export async function deleteApp(
  deps: Pick<Deps, "store" | "github" | "vercel" | "notifier" | "queue" | "config">,
  appId: number,
): Promise<{ ok: boolean; lines: string[] }> {
  const app = deps.store.getApp(appId);
  if (!app) return { ok: false, lines: ["이미 지워진 앱이에요."] };
  if (deps.queue.pending(app.slug)) return { ok: false, lines: [`*${app.name}* 은(는) 지금 작업 중이라 끝난 뒤에 지울 수 있어요.`] };

  if (app.connected) {
    deps.store.deleteApp(app.id);
    return {
      ok: true,
      lines: [`🔌 *${app.name}* 연결을 끊었어요. 레포(\`${app.repo}\`)와 배포는 그대로예요. 다시 연결하려면 \`/connectapp ${app.repo}\``],
    };
  }

  const lines: string[] = [];
  let ok = true;
  const attempt = async (label: string, fn: () => Promise<string>) => {
    try {
      lines.push(`✅ ${label}: ${await fn()}`);
    } catch (err) {
      ok = false;
      lines.push(`❌ ${label}: ${describeError(err).split("\n").slice(0, 3).join(" / ")}`);
    }
  };

  await attempt("GitHub 레포", async () => ((await deps.github.deleteRepo(app.repo)) ? `${app.repo} 삭제` : "이미 없음"));
  if (app.project_id) {
    const projectId = app.project_id;
    await attempt("GitHub Project 보드", async () => {
      await deps.github.deleteProject(projectId);
      return "삭제";
    });
  }
  await attempt("Vercel 프로젝트", async () => {
    if (!app.vercel_project_id) return "만들어지지 않았음";
    return (await deps.vercel.deleteProject(app.vercel_project_id)) ? "삭제" : "이미 없음";
  });
  await attempt("Slack 채널", async () => {
    if (!app.slack_channel_id) return "만들어지지 않았음";
    await deps.notifier.archiveChannel(app.slack_channel_id);
    return "보관 (대화 기록은 남아요)";
  });
  if (app.needs_backend) {
    lines.push("⚠️ AWS 백엔드(Lambda·API Gateway·DynamoDB)는 남아 있을 수 있어요. AWS 콘솔에서 확인해주세요.");
  }

  if (ok) {
    deps.store.deleteApp(app.id);
    lines.push(`🗑 *${app.name}* 기록 삭제. 같은 이름으로 다시 만들 수 있어요.`);
  } else {
    lines.push("일부 단계가 실패해서 기록은 남겨뒀어요. 원인을 고친 뒤 `/deleteapp` 을 다시 실행하면 남은 것만 정리해요.");
  }
  return { ok, lines };
}
