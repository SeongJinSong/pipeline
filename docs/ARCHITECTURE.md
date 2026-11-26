# 설계

## 참고한 것

글로벌셀의 챌똑이(`whitecubeinc/hermes-home`)에서 두 가지를 가져왔습니다.

- **Slack Socket Mode**: 공개 엔드포인트 없이 맥북·사내 서버에서 봇을 운영
- **멀티유저 쓰기 게이트**: 승인된 사람만 코드·배포를 바꿀 수 있고, 머지·배포는 명시적 승인이 따로 필요

챌똑이는 범용 에이전트(Hermes)가 Slack에서 무엇이든 하는 구조라면, pipeline은 **앱 하나 = 레포 하나 = Slack 채널 하나 = Vercel 프로젝트 하나**로 고정된 흐름에 집중합니다. 그래서 둘이 같이 써도 상태가 꼬이지 않고, 매번 같은 방식으로 배포돼요.

## 구성 요소

```
Slack (mujuhoney)
  │  Socket Mode
  ▼
pipeline 봇 (Node 22, 이 레포)
  ├─ src/slack/app.ts        /newapp, /apps, @멘션, 배포·닫기 버튼, 권한 확인
  ├─ src/flows/launch.ts     아이디어 → 스펙 → 레포 → 채널 → Vercel → AWS 설정 → 첫 MVP
  ├─ src/flows/change.ts     요구사항 → 브랜치 → 에이전트 → PR → 프리뷰 → 승인/머지
  ├─ src/integrations/
  │    claude.ts             아이디어 → AppSpec (로컬 `claude -p --json-schema`, 또는 Messages API)
  │    agent.ts              클론한 레포를 Claude가 직접 수정·빌드
  │                            - claude-cli(기본): 로컬에 로그인된 Claude Code(구독)를 `claude -p` 로 실행
  │                            - sdk: Claude Agent SDK + API 키 (상시 서버용)
  │    github.ts             레포 생성, clone/push, PR, 머지, Actions 변수·시크릿
  │    vercel.ts             프로젝트 생성(GitHub 연동), 환경변수, 배포 상태 대기
  ├─ src/store.ts            SQLite: apps, changes (스레드 ↔ 브랜치 ↔ PR)
  └─ templates/app/          새 앱 템플릿
       web/                  Next.js 15 + Tailwind  → Vercel (rootDirectory=web)
       backend/ infra/       Lambda + API Gateway + DynamoDB (Terraform)
       .github/workflows/    main 머지 시 OIDC로 terraform apply → API URL 을 Vercel env 로
       CLAUDE.md             에이전트가 읽는 레포 규칙

infra/bootstrap/             AWS 1회 설정: GitHub OIDC, 배포 역할, tfstate 버킷
```

## 비용 구조

| 단계 | 무엇으로 | 과금 |
|---|---|---|
| 아이디어 → 스펙 | 로컬 Claude Code 구독 (`claude -p --json-schema`) | 구독 요금 안에서 |
| 코드 수정 | 로컬 Claude Code 구독 (`claude -p`) | 구독 요금 안에서 (API 과금 없음) |
| (서버용 `AGENT_RUNNER=sdk`) | Messages API + Agent SDK + API 키 | 종량제, 작업당 `AGENT_MAX_BUDGET_USD` 상한 |

구독 로그인을 쓰려면 봇이 그 로그인이 있는 머신(지금은 Evan 맥)에서 돌아야 해요.

## 상태 모델

- `apps`: slug, repo, Slack 채널, Vercel 프로젝트, 백엔드 여부
- `changes`: Slack 스레드(ts) 하나가 브랜치 하나·PR 하나. 상태 `running → preview → merged | closed`, 실패 시 `failed` (같은 스레드에서 다시 요청 가능)

## 배포 경로

| 대상 | 언제 | 누가 |
|---|---|---|
| Vercel 프리뷰 | PR 브랜치에 push 될 때마다 | Vercel GitHub 연동 |
| Vercel 프로덕션 | main 머지 | Vercel GitHub 연동 |
| AWS 백엔드 | main 에 backend/·infra/ 변경 머지 | 앱 레포의 GitHub Actions (OIDC) |
| 앱인토스 테스트 번들 | PR 커밋마다 (`apps-in-toss.config.*` 있는 레포) | 봇 서버가 `build:ait` → `ait deploy` |
| 앱인토스 main 번들 | [배포] 머지 후 | 봇 서버. 검토 요청·출시는 콘솔에서 사람 |

AWS 자격증명은 pipeline 봇에 두지 않습니다. 봇은 앱 레포에 역할 ARN 같은 **변수**만 넣고, 실제 AWS 접근은 GitHub Actions가 OIDC로 짧게 받아서 합니다.

## 다음 단계 후보

- 앱 채널에서 "에러 로그 봐줘" → Vercel/CloudWatch 로그를 읽어 원인 분석 (유지보수)
- 도메인 연결 (`/domain app.example.com`)
- 프리뷰 스크린샷을 스레드에 첨부
- 봇을 상시 서버(EC2)로 옮기는 Terraform
