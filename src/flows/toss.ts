import { APPS_IN_TOSS_CONSOLE_URL } from "../integrations/appsintoss.js";
import { describeError } from "../util/errors.js";
import type { AppRecord } from "../store.js";
import type { Deps } from "./context.js";

export type TossStage = "preview" | "release";

/**
 * 클론한 레포가 앱인토스 미니앱이면 번들을 올리고 Slack 에 올릴 문구를 돌려준다. 미니앱이 아니면 null.
 * 실패해도 throw 하지 않는다 (PR·머지는 이미 끝난 뒤라 그 결과를 되돌리지 않는다).
 */
export async function uploadTossBundle(
  deps: Deps,
  app: AppRecord,
  repoDir: string,
  { stage, memo }: { stage: TossStage; memo: string },
): Promise<string | null> {
  const toss = deps.toss;
  if (!toss) return null;
  const project = toss.findProject(repoDir);
  if (!project) return null;
  if (!toss.enabled) {
    return "📱 앱인토스 미니앱이지만 봇 서버에 `APPS_IN_TOSS_API_KEY` 가 없어 번들 업로드는 건너뛰었어요. (pipeline README의 '앱인토스' 참고)";
  }
  if (stage === "preview" && !deps.config.APPS_IN_TOSS_PR_UPLOADS) return null;
  try {
    // 백엔드 주소 같은 NEXT_PUBLIC_* 는 Vercel 에만 있으므로 가져와 정적 빌드에 넣는다
    const publicEnv = app.vercel_project_id
      ? await deps.vercel.publicEnv(app.vercel_project_id, stage === "release" ? "production" : "preview").catch(() => ({}))
      : {};
    const r = await toss.buildAndUpload(project, memo, publicEnv);
    const head =
      stage === "preview"
        ? "📱 앱인토스 테스트 번들을 올렸어요. 토스 앱에서 열어 확인해 보세요 (워크스페이스 멤버만)."
        : "📱 앱인토스에 main 번들을 올렸어요. *아직 사용자에게는 안 나갔어요.* 콘솔 앱 출시 메뉴에서 토스앱 테스트 → 검토 요청 → 승인 후 출시하기를 눌러 주세요.";
    return [
      head,
      `• 테스트 링크: <${r.scheme}|토스앱에서 열기> (링크가 안 열리면 콘솔의 '토스앱 테스트' QR)`,
      `• appName \`${r.appName}\` · deploymentId \`${r.deploymentId}\``,
      `• 콘솔: ${APPS_IN_TOSS_CONSOLE_URL}`,
    ].join("\n");
  } catch (err) {
    console.error(err);
    return `⚠️ 앱인토스 번들 업로드에 실패했어요. ${stage === "release" ? "머지와 웹 배포는 그대로예요." : "PR은 그대로예요."}\n\`\`\`${describeError(err).slice(0, 1200)}\`\`\``;
  }
}
