# pipeline

Slack에서 **아이디어 → 앱 출시 → 요구사항 → 코드 수정 → 배포**까지 한 번에 하는 봇.
Evan과 동업자가 같은 Slack(mujuhoney)에서 같이 씁니다.

```
/newapp 동네 러닝 크루를 모집하는 앱
   │
   ├─ Claude가 MVP 스펙 정리 (기능·페이지·백엔드 필요 여부)
   ├─ GitHub 레포 생성 + 템플릿 커밋 (Next.js / 필요하면 Lambda+DynamoDB+Terraform)
   ├─ #app-<이름> Slack 채널 생성, 멤버 초대
   ├─ Vercel 프로젝트 연결 → 프로덕션 URL
   ├─ (백엔드) GitHub Actions ↔ AWS OIDC 배포 설정
   └─ 채널에서 바로 "스펙대로 MVP 구현" 작업 시작
        │
#app-<이름> 에서  @pipeline 로그인 페이지 추가해줘
   ├─ 브랜치 생성 → Claude 에이전트(Claude Agent SDK)가 코드 수정·빌드 확인
   ├─ PR 생성 → Vercel 프리뷰 URL 을 스레드에 게시
   ├─ 같은 스레드에서 @pipeline 버튼 더 크게  → 같은 PR에 이어서 수정
   └─ [🚀 배포] 버튼 → main 머지 → Vercel 프로덕션 (+ AWS 백엔드) 자동 배포
```

자세한 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 처음 설정 (1회)

1. **Slack 앱** — api.slack.com/apps → *From a manifest* → [`slack-manifest.yaml`](slack-manifest.yaml) 붙여넣기 → mujuhoney에 설치
   - Bot token(`xoxb-`) → `SLACK_BOT_TOKEN`
   - Basic Information → App-Level Token(`connections:write`) → `SLACK_APP_TOKEN`
2. **GitHub** — fine-grained PAT (`.env.example` 의 권한 목록) → `GITHUB_TOKEN`, 레포를 만들 계정/조직 → `GITHUB_OWNER`
3. **Vercel** — 토큰 발급, 그리고 Vercel GitHub App 이 `GITHUB_OWNER` 의 레포에 접근 가능해야 함 (All repositories 권장)
4. **AWS** (백엔드 필요한 앱용, 선택)
   ```bash
   cd infra/bootstrap
   terraform init && terraform apply -var github_owner=<GITHUB_OWNER>
   ```
   출력된 `deploy_role_arn`, `state_bucket` → `.env`
5. **Claude Code 로그인** — 봇을 돌릴 머신에서 `claude` 실행 후 `/login` (구독 계정). 스펙 정리와 코드 수정 모두 이 로그인으로 돌아서 Anthropic API 키가 필요 없어요 (`AGENT_RUNNER=claude-cli`, 기본값). 상시 서버에서 API로 돌리려면 `AGENT_RUNNER=sdk` + `ANTHROPIC_API_KEY`

## 실행

```bash
cp .env.example .env   # 값 채우기
npm install
npm start              # Socket Mode라 공개 URL·포트 개방 불필요
```

Node 22+, git 이 필요합니다. 맥북에서 띄워도 되고, 상시 운영은 작은 서버(EC2/Lightsail 등)에서 `npm start` 를 pm2/systemd 로 돌리면 됩니다.

## Slack 사용법

| 어디서 | 무엇을 | 결과 |
|---|---|---|
| 아무 곳 | `/newapp <아이디어>` | 스펙 → 레포 → 채널 → Vercel → (AWS) → MVP 구현 PR |
| 아무 곳 | `/myapps` | 만든 앱 목록 |
| `#app-*` | `@pipeline <요구사항>` | 새 브랜치·PR·프리뷰 |
| 그 스레드 | `@pipeline <추가 요구>` | 같은 PR에 이어서 수정 |
| 결과 메시지 | 🚀 배포 / 닫기 | 머지 후 프로덕션 배포 / PR 닫기 |

**권한**: `SLACK_ALLOWED_USERS` 에 있는 사람만 앱 생성·코드 수정·배포를 할 수 있어요. 다른 사람의 멘션은 답만 하고 코드는 건드리지 않습니다.

## 안전장치

- 에이전트는 작업마다 새로 클론한 디렉터리에서만 파일을 고치고, `git push`·`gh`·`vercel`·`aws`·`terraform` 명령은 막혀 있어요. push·PR·머지는 파이프라인 코드가 합니다.
- 프로덕션 반영은 항상 사람이 [🚀 배포] 버튼을 눌러야 일어나요 (확인 대화상자 포함).
- 코드 수정은 기본적으로 로컬 Claude Code 구독으로 돌아 API 비용이 들지 않아요 (구독 사용량 한도는 적용). 결과 메시지의 금액은 API로 했다면 들었을 환산 금액이에요.
- 서버에서 `AGENT_RUNNER=sdk` 로 API 종량제를 쓸 때는 작업 1건당 상한 `AGENT_MAX_BUDGET_USD` (기본 $10)가 걸려요.
- 같은 앱의 작업은 한 줄로 처리돼요 (동시에 같은 레포를 만지지 않음).
- AWS 배포 역할은 GitHub OIDC + main 브랜치로만 맡을 수 있고, Lambda/API Gateway/DynamoDB/Logs 와 `*-api-lambda` IAM 역할로 권한이 제한돼요.

## 개발

```bash
npm run typecheck
npm test
```
