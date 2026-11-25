# pipeline

Slack에서 **아이디어 → 앱 출시 → 요구사항 → 코드 수정 → 배포**까지 한 번에 하는 봇.
Evan과 동업자가 같은 Slack(mujuhoney)에서 같이 씁니다.

```
/newapp 동네 러닝 크루를 모집하는 앱        (또는 아무 채널에서 @pipeline 동네 러닝 크루…)
   │
   └─ 그 메시지 아래 🧵 스레드 = 이 아이디어의 PRD 방
        ├─ Claude가 PRD v1 정리 (기능·페이지·백엔드 필요 여부·열린 질문)
        ├─ 스레드에 답하며 PRD 수정 ("로그인은 빼자", "알림 기능 추가")  → PRD v2, v3…
        │    대화는 DB에 쌓여 매번 같이 넘어가서 맥락이 유지돼요
        └─ [🚀 이대로 출시]
             ├─ GitHub 레포 + 템플릿 + SPEC.md (PRD 대화 기록 포함)
             ├─ #app-<이름> 채널 생성, 멤버 초대, PRD 스레드 링크
             ├─ Vercel 프로젝트 → 프로덕션 URL
             ├─ (백엔드) GitHub Actions ↔ AWS OIDC 배포 설정
             └─ 앱 채널에서 "PRD대로 MVP 구현" 작업 시작
                  │
#app-<이름> 에서  @pipeline 로그인 페이지 추가해줘
   ├─ 그 메시지 아래 스레드에서 작업: 브랜치 → Claude가 코드 수정·빌드 확인 → PR → Vercel 프리뷰
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

Node 22+, git 이 필요합니다. 맥북에서 띄워도 되고, 상시 운영은 서버에서 systemd 로 돌리면 됩니다: [deploy/README.md](deploy/README.md)

## Slack 사용법

| 어디서 | 무엇을 | 결과 |
|---|---|---|
| 아무 채널 | `/newapp <아이디어>` 또는 `@pipeline <아이디어>` | 그 아래 스레드에 PRD 초안 |
| PRD 스레드 | 답글 (멘션 없어도 됨) | PRD 수정·질문, 맥락 유지 |
| PRD 카드 | 🚀 이대로 출시 / 접기 | 레포 → 채널 → Vercel → (AWS) → MVP 구현 PR |
| 아무 곳 | `/myapps` | 만든 앱 목록 (실패한 앱 포함) |
| 기존 서비스 채널 | `/connectapp <레포>` | 이미 있는 레포(예: mujuhoney)를 이 채널에 연결 → 이후 멘션으로 수정·배포 |
| 아무 곳 | `/deleteapp <앱>` | 확인 후 GitHub 레포·Vercel 프로젝트 삭제, 채널 보관 (테스트·실패한 앱 정리) |
| `#app-*` | `@pipeline <요구사항>` | 새 브랜치·PR·프리뷰 |
| 그 스레드 | `@pipeline <추가 요구>` | 같은 PR에 이어서 수정 |
| 결과 메시지 | 🚀 배포 / 닫기 | 머지 후 프로덕션 배포 / PR 닫기 |

**권한**: 기본은 `SLACK_ALLOWED_USERS` 에 있는 사람만 앱 생성·코드 수정·배포를 할 수 있어요. `SLACK_OPEN_ACCESS=true` 면 워크스페이스 누구나 요청·배포 버튼을 쓸 수 있고, 레포 연결(`/connectapp`)과 삭제(`/deleteapp`)만 `SLACK_ALLOWED_USERS` 가 해요.

**기존 레포 연결**: 봇이 만들지 않은 서비스도 `/connectapp` 으로 채널에 붙일 수 있어요. Vercel 프로젝트가 연결된 레포면 프리뷰·운영 URL까지 따라가고, 아니면(Cloudflare 등) PR을 만들고 [배포] 시 기본 브랜치에 머지해 레포의 자동 배포에 맡겨요. 연결한 레포에 `/deleteapp` 을 하면 연결만 끊고 레포·배포는 그대로 둬요.

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
