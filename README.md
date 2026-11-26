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
             │    이슈 템플릿·PR 템플릿·docs/plans 규칙 + GitHub Project 보드
             ├─ #app-<이름> 채널 생성, 멤버 초대, PRD 스레드 링크
             ├─ Vercel 프로젝트 → 프로덕션 URL
             ├─ (백엔드) GitHub Actions ↔ AWS OIDC 배포 설정
             └─ 앱 채널에서 "PRD대로 MVP 구현" 작업 시작
                  │
#app-<이름> 에서  @pipeline 로그인 페이지 추가해줘
   ├─ 그 메시지 아래 스레드에서 작업: 이슈 등록 → 브랜치 + 계획 문서(docs/plans) → Claude가 코드 수정·빌드 확인
   │    → PR(Closes #이슈) → Vercel 프리뷰 (이슈·PR은 Project 보드에 In Progress)
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
5. **앱인토스** (토스 미니앱으로도 낼 앱이 있을 때, 선택) — 아래 [앱인토스](#앱인토스-토스-미니앱) 참고. 콘솔 '키' 메뉴의 API 키 → `APPS_IN_TOSS_API_KEY`
6. **Claude Code 로그인** — 봇을 돌릴 머신에서 `claude` 실행 후 `/login` (구독 계정). 스펙 정리와 코드 수정 모두 이 로그인으로 돌아서 Anthropic API 키가 필요 없어요 (`AGENT_RUNNER=claude-cli`, 기본값). 상시 서버에서 API로 돌리려면 `AGENT_RUNNER=sdk` + `ANTHROPIC_API_KEY`

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

## 이슈 · Project · PR 문서

upbit-cc / upbit-cdx 에서 쓰던 "이슈가 원장, PR마다 계획 문서, Project 는 상태 보기" 방식을 모든 앱에 기본으로 넣어요. 왜 이걸 골랐는지는 [docs/plans/0001-app-issue-project-plans.md](docs/plans/0001-app-issue-project-plans.md).

- **새 앱 템플릿**: `.github/ISSUE_TEMPLATE/`(요구사항·버그 폼), `.github/pull_request_template.md`, `docs/plans/README.md`·`TEMPLATE.md`, CLAUDE.md 작업 규칙.
- **Slack 요청 1건** → 이슈(`slack-request` 라벨, 스레드 링크) → `docs/plans/issue-<번호>-<주제>.md` 뼈대를 파이프라인이 만들고 에이전트가 근거·결정·검증을 채움 → PR 본문에 `Closes #번호` + 문서 링크. 같은 스레드의 추가 요청은 이슈 댓글과 문서의 변경 기록에 덧붙어요. [닫기] 하면 이슈도 "계획 안 함"으로 닫혀요.
- **Project 보드**: `/newapp` 때 앱 이름으로 레포에 연결된 보드를 만들고 이슈·PR을 In Progress 로 넣어요. 머지되면 GitHub 기본 워크플로가 Done 으로 옮겨요. 개인 계정 Project 는 fine-grained PAT 로 못 만들어서 classic PAT(scope `project`, `repo`)를 `GITHUB_PROJECT_TOKEN` 에 넣어야 해요. 없으면 보드만 건너뛰어요.
- 이슈 생성은 `GITHUB_TOKEN` 에 **Issues: Read and write** 권한이 필요해요. 권한이 없으면 이슈 없이 `docs/plans/change-<번호>-*.md` 로 진행해요.

## 앱인토스 (토스 미니앱)

PRD에서 "앱인토스로 내자", "토스 미니앱으로" 처럼 말하면 스펙의 배포 대상이 `toss` 가 되고, 같은 Next.js 앱을 웹(Vercel)과 토스 앱 미니앱 둘 다로 내요. 방식은 공식 CLI(`@apps-in-toss/web-framework` 의 `ait`)를 따라요. 근거 문서: [미니앱 테스트하기(CI/CD 명령어)](https://developers-apps-in-toss.toss.im/guide/operation/toss.md), [미니앱 등록하기](https://developers-apps-in-toss.toss.im/guide/operation/console-workspace.md), [서버 API(mTLS)](https://developers-apps-in-toss.toss.im/documentation/integration/server-api.md).

| 단계 | 누가 | 무엇을 |
|---|---|---|
| 워크스페이스 (1회) | 사람 | [콘솔](https://apps-in-toss.toss.im) 가입(토스 비즈니스, 만 19세 이상) → 워크스페이스 |
| 콘솔 MCP 로그인 (1회) | 사람 | 봇 서버에 콘솔 MCP 등록 후 토스 계정으로 로그인, `TOSS_CONSOLE_MCP=true` ([deploy/README](deploy/README.md#앱인토스-콘솔-mcp-slack-에서-콘솔-작업)). API 키(`APPS_IN_TOSS_API_KEY`)는 선택 |
| 멤버 (1회) | 사람 | 토스앱 테스트(QR·테스트 링크)는 워크스페이스 멤버만 돼요. 동업자 초대 |
| 사업자 등록 (필요할 때) | 사람 | 토스 로그인·인앱 결제·토스페이·프로모션을 쓰려면 콘솔 **내 정보**에서 먼저 |
| 앱 등록 (앱마다) | 사람 → Slack | `/newapp` 때 봇이 알려 주는 appName(=slug)으로 등록. 콘솔 **앱 +등록하기** 또는 `@pipeline 콘솔 <appName> 앱 만들어줘` ([실행] 확인 후, 로고 필요). appName 은 나중에 못 바꿔요 |
| 템플릿 | 봇 | `web/apps-in-toss.config.ts`, 정적 내보내기용 `next.config.ts`, `npm run build:ait`, 앱 레포 `docs/apps-in-toss.md` |
| 테스트 번들 (PR마다) | 봇 | PR 브랜치를 `build:ait` 로 묶어 업로드(키가 있으면 `ait deploy`, 없으면 콘솔 MCP) → 스레드에 `intoss-private://…` 테스트 링크 (`APPS_IN_TOSS_PR_UPLOADS=false` 로 끔) |
| main 번들 ([배포]) | 봇 | 머지 후 main 을 다시 빌드해 업로드하고, 콘솔에서 할 일을 스레드에 남겨요 |
| 검토 요청 | Slack | `@pipeline 콘솔 카페인 아웃 최신 번들 검토 요청해줘` → 봇이 할 일을 보여 주고 [실행]을 누르면 요청. 콘솔 **앱 출시** 화면에서 해도 돼요 |
| 출시하기 | 사람 | 승인되면 콘솔 **앱 출시**에서 **출시하기**. 콘솔 MCP 에 이 버튼이 없어요. 업로드만으로는 사용자에게 안 나가요 |
| mTLS 인증서 (서버 API 쓸 때) | 사람 | 콘솔 **개발 > mTLS 인증서**에서 앱마다 발급. 토스 로그인 토큰 교환·결제·푸시·포인트 API용. 레포가 아니라 백엔드 비밀값으로 |

- `/connectapp` 으로 붙인 기존 레포도 루트나 `web/` 에 `apps-in-toss.config.*` 가 있으면 같은 방식으로 올려요. `build:ait` 스크립트가 없으면 `npm run build` 뒤 `ait build` 를 써요.
- 빌드·업로드는 봇 서버에서 해요. 빌드는 레포 코드를 실행하므로 봇의 Slack·GitHub·Vercel 토큰과 앱인토스 키를 빼고 빈 HOME 으로 돌리고, 키는 `ait deploy --api-key` 인자로만 넘겨요 (로그·Slack 에는 `***`).
- **Slack 에서 콘솔 작업** (`TOSS_CONSOLE_MCP=true`, 관리자만): 어느 채널에서든 `@pipeline 콘솔 …`. 예: `콘솔 앱 상태 알려줘`, `콘솔 프리랜서 세금 반려 사유 알려줘`, `콘솔 이거 먹어도 돼? v3 검토 요청해줘`, `콘솔 퇴사 버티기 이전 버전으로 롤백해줘`. 앱 채널에서 앱 이름을 빼면 그 앱이에요.
  - 봇이 서버 Claude Code 를 콘솔 MCP 도구만 쓰게 열어 돌려요 (Bash·파일 도구 없음). 조회 도구(이름이 list/get/status… 인 것)는 바로 답하고, 그 밖의 도구(만들기·검토 요청·취소·롤백·푸시 등)는 할 일을 보여 준 뒤 [실행]을 눌러야 그 도구만 열어 다시 돌려요.
  - 확인 대기 중인 작업은 메모리에만 있어 봇이 재시작되면 버튼이 만료돼요. 24시간이 지나도 만료돼요.
  - 코드 수정 에이전트는 `--strict-mcp-config` 로 이 MCP 를 못 써요 (앱 레포 코드가 토스 계정 권한에 닿지 않게).

## 안전장치

- 에이전트는 작업마다 새로 클론한 디렉터리에서만 파일을 고치고, `git push`·`gh`·`vercel`·`aws`·`terraform`·`ait deploy` 명령은 막혀 있어요. push·PR·머지·번들 업로드는 파이프라인 코드가 합니다.
- 에이전트 프로세스에는 봇의 Slack·GitHub·Vercel 토큰과 앱인토스 키를 넘기지 않고, 서버에 등록된 MCP(앱인토스 콘솔)도 열지 않아요.
- 앱인토스 콘솔을 바꾸는 작업은 Slack [실행] 버튼(확인 대화상자 포함)을 관리자가 눌러야 일어나요.
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
