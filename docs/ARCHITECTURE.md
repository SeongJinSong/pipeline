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
  │    claude.ts             Messages API (구조화 출력) 로 아이디어 → AppSpec
  │    agent.ts              Claude Agent SDK 로 클론한 레포를 직접 수정·빌드
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

## 상태 모델

- `apps`: slug, repo, Slack 채널, Vercel 프로젝트, 백엔드 여부
- `changes`: Slack 스레드(ts) 하나가 브랜치 하나·PR 하나. 상태 `running → preview → merged | closed`, 실패 시 `failed` (같은 스레드에서 다시 요청 가능)

## 배포 경로

| 대상 | 언제 | 누가 |
|---|---|---|
| Vercel 프리뷰 | PR 브랜치에 push 될 때마다 | Vercel GitHub 연동 |
| Vercel 프로덕션 | main 머지 | Vercel GitHub 연동 |
| AWS 백엔드 | main 에 backend/·infra/ 변경 머지 | 앱 레포의 GitHub Actions (OIDC) |

AWS 자격증명은 pipeline 봇에 두지 않습니다. 봇은 앱 레포에 역할 ARN 같은 **변수**만 넣고, 실제 AWS 접근은 GitHub Actions가 OIDC로 짧게 받아서 합니다.

## 다음 단계 후보

- 앱 채널에서 "에러 로그 봐줘" → Vercel/CloudWatch 로그를 읽어 원인 분석 (유지보수)
- 도메인 연결 (`/domain app.example.com`)
- 프리뷰 스크린샷을 스레드에 첨부
- 봇을 상시 서버(EC2)로 옮기는 Terraform
