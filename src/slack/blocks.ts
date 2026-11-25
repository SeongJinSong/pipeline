import type { AppSpec } from "../integrations/claude.js";
import type { AppRecord, ChangeRecord } from "../store.js";

export const ACTION_APPROVE = "change_approve";
export const ACTION_REJECT = "change_reject";
export const ACTION_DELETE = "app_delete";

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });

export function specBlocks(spec: AppSpec): unknown[] {
  return [
    section(`*${spec.name}* — ${spec.one_liner}\n_대상: ${spec.target_users}_`),
    section(`*핵심 기능*\n${spec.core_features.map((f) => `• ${f}`).join("\n")}`),
    section(`*페이지*\n${spec.pages.map((p) => `• \`${p.path}\` ${p.purpose}`).join("\n")}`),
    section(`*백엔드*: ${spec.needs_backend ? "필요 (AWS Lambda + DynamoDB)" : "없음 (Vercel만)"}`),
    ...(spec.open_questions.length
      ? [section(`*결정이 필요한 것*\n${spec.open_questions.map((q) => `• ${q}`).join("\n")}`)]
      : []),
  ];
}

export function changeBlocks(args: {
  change: ChangeRecord;
  summary: string;
  prUrl: string;
  previewUrl: string | null;
  previewState: string;
  costUsd: number;
}): unknown[] {
  const preview = args.previewUrl
    ? `<${args.previewUrl}|프리뷰 열기>`
    : `프리뷰 ${args.previewState === "TIMEOUT" ? "대기 시간 초과" : args.previewState}`;
  return [
    section(args.summary || "작업을 마쳤어요."),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${args.prUrl}|PR #${args.change.pr_number}> · ${preview} · 토큰 환산 $${args.costUsd.toFixed(2)} · 스레드에 답하면 이어서 수정`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ACTION_APPROVE,
          style: "primary",
          text: { type: "plain_text", text: "🚀 배포 (머지)" },
          value: String(args.change.id),
          confirm: {
            title: { type: "plain_text", text: "프로덕션에 배포할까요?" },
            text: { type: "mrkdwn", text: "PR을 main에 머지하면 Vercel(및 AWS 백엔드)이 바로 배포돼요." },
            confirm: { type: "plain_text", text: "배포" },
            deny: { type: "plain_text", text: "취소" },
          },
        },
        {
          type: "button",
          action_id: ACTION_REJECT,
          style: "danger",
          text: { type: "plain_text", text: "닫기" },
          value: String(args.change.id),
        },
      ],
    },
  ];
}

export function deleteConfirmBlocks(app: AppRecord): unknown[] {
  const items = [
    `• GitHub 레포 \`${app.repo}\` *삭제* (되돌릴 수 없어요)`,
    app.vercel_project_id ? "• Vercel 프로젝트 *삭제*" : null,
    app.slack_channel_id ? `• <#${app.slack_channel_id}> 채널 *보관* (기록은 남아요)` : null,
    app.needs_backend ? "• ⚠️ AWS 백엔드는 자동으로 지워지지 않아요" : null,
  ].filter(Boolean);
  return [
    section(`*${app.name}* (\`${app.slug}\`, ${app.status}) 을(를) 지울까요?\n${items.join("\n")}`),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ACTION_DELETE,
          style: "danger",
          text: { type: "plain_text", text: "🗑 삭제" },
          value: String(app.id),
          confirm: {
            title: { type: "plain_text", text: "정말 지울까요?" },
            text: { type: "mrkdwn", text: `\`${app.repo}\` 레포와 Vercel 프로젝트가 영구 삭제돼요.` },
            confirm: { type: "plain_text", text: "삭제" },
            deny: { type: "plain_text", text: "취소" },
          },
        },
      ],
    },
  ];
}
