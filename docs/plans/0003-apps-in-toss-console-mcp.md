# 0003 Slack 에서 앱인토스 콘솔 작업 (콘솔 MCP)

- 상태: 제안 (PR)
- 요청: Evan, 2026-11-26 ("지금 Mac 에서 MCP 로 하는 걸 Slack 으로 가능하게 하고 싶은 게 목적")
- 앞선 작업: [0002 앱인토스 배포 지원](0002-apps-in-toss.md)

## 목표

Evan 이 Mac 의 Claude Code + 앱인토스 콘솔 MCP 로 하던 콘솔 작업(앱 상태 확인, 앱 만들기, 번들 업로드, 검토 요청, 롤백)을 Slack 에서 봇으로 한다.

## 확인한 것 (2026-11-26)

- Mac 설정: user scope, http, `https://mcp.toss.im/adapters/apps-in-toss-console/mcp`, `oauth.clientId = mcp-gateway`, 고정 헤더 없음. Claude Code 2.1.332.
- 콘솔 MCP 도구 약 100개: workspace_*, miniapp_*, bundle_*, review_*, initial_review_submit, iap_*, iaa_*, promotion_*, push_*, dashboard_* 등.
  - 번들: `bundle_upload(workspaceId, miniAppId, {deploymentId})` → uploadUrl 에 PUT → `bundle_upload_complete` → `bundle_build_status`.
  - 검토 요청: 첫 등록 전 앱은 `initial_review_submit`, 등록된 앱은 `bundle_submit_review` / `review_submit`. 취소 `review_cancel`. 롤백 `bundle_rollback`.
  - 없는 것: 출시하기(라이브 전환), API 키 조회·발급.
- API 키(`ait deploy --api-key`)는 앱 범위가 정해질 수 있어, 앱이 늘 때마다 키를 바꿔야 할 수 있다. 콘솔 MCP 는 계정 권한이라 워크스페이스의 모든 앱을 다룬다.
- `claude mcp login --no-browser <name>`: 화면 없는 서버에서 주소를 출력하고, 브라우저에서 승인한 뒤 돌아온 주소를 붙여 넣으면 된다 (포트 포워딩 불필요).
- `claude -p --tools "" --permission-mode default --permission-prompts none --allowedTools <MCP 도구>`: 내장 도구 없이, 허용한 MCP 도구만 쓰고 나머지는 묻지 않고 거절한다 (로컬에서 MCP 서버로 실제 확인).
- stream-json 의 `system/init` 에 MCP 도구 목록과 서버 상태가 모델 호출 전에 나온다 → 도구 목록 조회를 비용 없이 한다.

## 결정

1. **서버 Claude Code 에 같은 MCP 를 user scope 로 등록하고 Evan 이 한 번 로그인.** 토큰 보관·갱신은 Claude Code 가 한다. 봇 코드는 토큰을 보지 않는다.
2. **Slack 진입점은 `@pipeline 콘솔 …`.** "토스 …" 는 "토스 로그인 붙여줘" 같은 코드 요청과 겹쳐서 쓰지 않았다. 슬래시 명령은 Slack 앱 설정을 바꿔야 해서 미뤘다. 관리자(SLACK_ALLOWED_USERS)만.
3. **조회는 바로, 바뀌는 작업은 [실행] 후.** 도구 이름이 조회 단어(list/get/status/overview…)면 조회, 나머지(모르는 도구 포함)는 바뀌는 작업으로 본다. 계획 단계는 조회 도구만 열고, 모델이 할 일을 JSON 으로 돌려주면 Slack 에 보여 준다. [실행]을 누르면 그 도구만 추가로 열어 다시 돌린다.
4. **번들 업로드는 키가 있으면 키, 없으면 콘솔 MCP.** 파일 PUT 은 봇(node)이 직접 한다. 에이전트에는 Bash·파일·네트워크 도구를 주지 않는다 (콘솔 응답에 섞인 지시문으로 서버 파일을 내보내지 못하게).
5. **코드 수정 에이전트는 MCP 차단.** user scope MCP 는 모든 claude 실행에 붙으므로 코드 수정 에이전트에 `--strict-mcp-config`(SDK 는 `strictMcpConfig`)를 붙였다.
6. **출시하기는 사람.** MCP 에 도구가 없고, 사용자에게 바로 나가는 단계다.

## 버린 대안

- 봇이 MCP 를 직접(HTTP+OAuth) 부르기: 토큰 발급·갱신을 직접 구현해야 하고 Claude Code 가 이미 한다.
- 앱마다 API 키: 콘솔에서 키를 계속 발급해 서버에 넣어야 한다. 키 발급 도구도 없다.
- 확인 없이 모두 실행: 검토 요청·롤백·푸시는 되돌리기 어렵거나 사용자에게 닿는다.

## 한계와 위험

- 실제 콘솔 MCP 로는 서버에서 아직 돌려 보지 못했다 (로그인 전). 도구 허용·거절과 init 목록은 다른 MCP 서버로 확인했다. 로그인 후 `@pipeline 콘솔 앱 상태 알려줘` 로 먼저 확인한다.
- 조회/변경 판단이 이름 기반이다. 이름이 조회처럼 보이는데 바꾸는 도구가 있으면 확인 없이 실행될 수 있다. 콘솔 MCP 도구 이름 규칙(동사로 끝남)을 보고 정했다.
- 확인 대기 작업은 메모리에만 둔다. 봇 재시작 시 버튼이 만료된다.
- 로그인한 토스 계정 권한 전체로 동작한다. 관리자만 부를 수 있다.
- 콘솔 MCP 업로드에는 메모 필드가 없어, 키 업로드처럼 PR 번호 메모가 콘솔에 남지 않는다.

## 결과

(머지·배포 후 채움)
