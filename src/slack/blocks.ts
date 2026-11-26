import type { AppSpec } from "../integrations/claude.js";
import type { AppRecord, ChangeRecord } from "../store.js";

export const ACTION_APPROVE = "change_approve";
export const ACTION_REJECT = "change_reject";
export const ACTION_DELETE = "app_delete";
export const ACTION_DRAFT_LAUNCH = "draft_launch";
export const ACTION_DRAFT_CANCEL = "draft_cancel";

const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text: text.slice(0, 2900) },
});

const VERDICT: Record<AppSpec["advice"]["verdict"], string> = {
  build: "🛠 직접 만드는 게 좋아요",
  buy: "🛒 기존 서비스를 쓰는 게 나아요",
  hybrid: "🧩 핵심만 만들고 어려운 부분은 기존 서비스",
  drop: "✋ 하지 않는 게 나을 수 있어요",
};

export function adviceBlocks(advice: AppSpec["advice"]): unknown[] {
  const alts = advice.alternatives.map(
    (a) =>
      `• ${a.url ? `<${a.url}|${a.name}>` : `*${a.name}*`}: ${a.what} (${a.price})`,
  );
  return [
    section(`*${VERDICT[advice.verdict]}*\n${advice.summary}`),
    ...(alts.length
      ? [section(`*쓸 만한 기존 서비스*\n${alts.join("\n")}`)]
      : []),
    ...(advice.hard_parts.length
      ? [
          section(
            `*어려운 부분*\n${advice.hard_parts.map((h) => `• ${h}`).join("\n")}`,
          ),
        ]
      : []),
    { type: "divider" },
  ];
}

export function specBlocks(spec: AppSpec): unknown[] {
  return [
    section(`*${spec.name}* — ${spec.one_liner}\n_대상: ${spec.target_users}_`),
    section(
      `*핵심 기능*\n${spec.core_features.map((f) => `• ${f}`).join("\n")}`,
    ),
    section(
      `*페이지*\n${spec.pages.map((p) => `• \`${p.path}\` ${p.purpose}`).join("\n")}`,
    ),
    section(
      `*백엔드*: ${spec.needs_backend ? "필요 (AWS Lambda + DynamoDB)" : "없음 (Vercel만)"}\n` +
        `*배포*: ${spec.platform === "toss" ? "웹(Vercel) + 앱인토스(토스 미니앱)" : "웹(Vercel)"}`,
    ),
    ...(spec.open_questions.length
      ? [
          section(
            `*결정이 필요한 것*\n${spec.open_questions.map((q) => `• ${q}`).join("\n")}`,
          ),
        ]
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
    : args.previewState === "NONE"
      ? "머지하면 자동 배포"
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
            text: {
              type: "mrkdwn",
              text: "PR을 main에 머지하면 Vercel(및 AWS 백엔드)이 바로 배포돼요.",
            },
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
  if (app.connected) {
    return [
      section(`*${app.name}* 은 연결한 기존 레포라 \`${app.repo}\` 와 배포는 건드리지 않고 *이 채널과의 연결만* 끊어요.`),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTION_DELETE,
            text: { type: "plain_text", text: "🔌 연결 끊기" },
            value: String(app.id),
          },
        ],
      },
    ];
  }
  const items = [
    `• GitHub 레포 \`${app.repo}\` *삭제* (되돌릴 수 없어요)`,
    app.vercel_project_id ? "• Vercel 프로젝트 *삭제*" : null,
    app.slack_channel_id
      ? `• <#${app.slack_channel_id}> 채널 *보관* (기록은 남아요)`
      : null,
    app.needs_backend ? "• ⚠️ AWS 백엔드는 자동으로 지워지지 않아요" : null,
  ].filter(Boolean);
  return [
    section(
      `*${app.name}* (\`${app.slug}\`, ${app.status}) 을(를) 지울까요?\n${items.join("\n")}`,
    ),
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
            text: {
              type: "mrkdwn",
              text: `\`${app.repo}\` 레포와 Vercel 프로젝트가 영구 삭제돼요.`,
            },
            confirm: { type: "plain_text", text: "삭제" },
            deny: { type: "plain_text", text: "취소" },
          },
        },
      ],
    },
  ];
}

/** PRD 스레드의 PRD 카드: 스펙 + [🚀 이대로 출시] [접기] */
export function draftBlocks(
  spec: AppSpec,
  draftId: number,
  opts: { version: number; reply?: string },
): unknown[] {
  return [
    ...(opts.reply ? [section(opts.reply), { type: "divider" }] : []),
    section(`📋 *PRD v${opts.version}*`),
    ...adviceBlocks(spec.advice),
    ...specBlocks(spec),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            spec.advice.verdict === "buy" || spec.advice.verdict === "drop"
              ? "이 스레드에 답하면 같이 더 따져보거나 방향을 바꿀 수 있어요. 그래도 만들겠다면 출시를 눌러주세요."
              : "이 스레드에 답하면 PRD를 고쳐요 (질문해도 돼요). 마음에 들면 출시를 눌러주세요.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ACTION_DRAFT_LAUNCH,
          style: "primary",
          text: { type: "plain_text", text: "🚀 이대로 출시" },
          value: String(draftId),
          confirm: {
            title: { type: "plain_text", text: "이 PRD로 출시할까요?" },
            text: {
              type: "mrkdwn",
              text: "GitHub 레포, Slack 채널, Vercel 프로젝트를 만들고 MVP 구현을 시작해요.",
            },
            confirm: { type: "plain_text", text: "출시" },
            deny: { type: "plain_text", text: "취소" },
          },
        },
        {
          type: "button",
          action_id: ACTION_DRAFT_CANCEL,
          text: { type: "plain_text", text: "접기" },
          value: String(draftId),
        },
      ],
    },
  ];
}
