# 리비 · 리뷰어 (두 번째 Slack 앱 + Codex)

Slack 앱 이름은 **리비**예요 (2026-11-28 `리뷰어`에서 바꿈). `@리비` 멘션, `리비야 …`, 예전처럼 `리뷰어야 …` 로 불러도 돼요 (`REVIEWER_CALL_NAMES`).

파피가 PR 을 올리면 **리비**가 같은 Slack 스레드에서 리뷰하고, 파피가 그걸 반영해 다시 push 하는 대화를 Slack 에 남겨요. 같은 내용이 GitHub PR 댓글에도 남아요. 머지는 지금처럼 사람이 [🚀 배포] 버튼으로 해요.

```
#app-<이름> 스레드
  Evan   @파피 로그인 페이지 추가해줘
  파피   🛠️ 작업 시작… → PR #12 + 프리뷰 + [배포] 버튼
  리비   🔍 1차 리뷰: 고칠 게 있어요  🔴 auth.ts:40 세션 만료 처리 없음 …  "파피, 반영 부탁해요"   (+ PR 댓글)
  파피   🛠️ 리비 1차 리뷰 지적 반영할게요 → push, "1번 반영함 / 2번은 범위 밖이라 안 함"          (+ PR 댓글)
  리비   ✅ 2차 리뷰: 머지해도 좋아 보여요                                               (+ PR 댓글)
  Joy    [🚀 배포]
```

## 역할 나누기

| | 파피 | 리비 (리뷰어) |
|---|---|---|
| Slack 앱 | 기존 앱 (`SLACK_BOT_TOKEN`) | 새 앱 (`REVIEWER_SLACK_BOT_TOKEN`) |
| 모델 | Claude Code (`claude -p`, 구독) | Codex (`codex exec`, ChatGPT/OpenAI 로그인) |
| 권한 | 레포 쓰기, push, PR, 배포·서버 작업 | **읽기 전용** (`--sandbox read-only`: 파일 수정·네트워크 막힘). 코멘트만 |
| 작업 폴더 | 작업마다 새 클론 (브랜치) | 리뷰마다 따로 클론. 원격 주소의 GitHub 토큰은 지운 뒤 Codex 실행 |
| 맥락 | 요청·계획 문서·리뷰 지적 | 요청·diff·레포 규칙·**이전 리뷰와 파피 반영 기록** (DB `reviews` 테이블) |

두 페르소나는 **같은 서버 프로세스**(systemd `pipeline`)에서 돌지만 Slack 토큰·실행 프로세스·모델·로그인이 다 달라서 맥락이 섞이지 않아요. 매 리뷰는 새 Codex 세션(`--ephemeral`)으로 돌고, 필요한 기억은 DB 에 쌓은 이전 라운드 기록을 프롬프트에 넣어 이어가요. (Slack 이 아니라 DB·PR 댓글·레포 문서가 원본이에요.)

봇끼리 Slack 이벤트로 말을 주고받지 않아요. Slack 은 봇 메시지를 다른 봇에 다시 넘기지 않게 막혀 있고(`bot_id` 무시), 파이프라인 코드가 순서를 직접 정해요: 파피 push → 리뷰 → (지적 있으면) 파피 반영 → 리뷰 … 그래서 무한 루프가 없어요.

## 왕복 규칙

- 파피가 PR 에 push 할 때마다 리뷰해요 (첫 PR, 같은 스레드 추가 요청, 리뷰 반영 모두).
- 리뷰 결과 `must`/`should` 지적이 있으면 파피가 자동으로 반영해요. `nit`(취향)만 있으면 반영하지 않아요.
- 자동 반영은 `REVIEW_MAX_ROUNDS` 번까지 (기본 2). 그 뒤에도 지적이 남으면 파피가 "사람이 판단해 주세요" 라고 남기고 멈춰요.
- 파피는 리뷰어 말을 무조건 따르지 않아요. 지적마다 반영/미반영과 이유를 남기고, 하나도 안 고치면 왕복이 끝나요.
- 사람이 같은 스레드에서 `@파피 …` 로 새로 요청하거나 `@리비` 를 부르면 횟수를 처음부터 세요.
- 리뷰 도중에도 [🚀 배포] 버튼은 그대로 쓸 수 있어요. 머지·닫기 뒤에 도착한 리뷰 반영은 건너뛰어요.

## Slack 에서 부르기

| 어디서 | 무엇을 | 결과 |
|---|---|---|
| PR 스레드 | `@리비` 또는 `리비야 …` / `리뷰어야 …` (예: `리비야 보안 위주로 봐줘`) | 지금 브랜치를 다시 리뷰. 덧붙인 말은 중점 사항으로 |
| 그 밖의 곳 | `@리비` | PR 스레드에서 불러 달라고 안내 |

## 설정 (Evan 이 손으로 한 번)

### 1. Slack 앱 만들기

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → 워크스페이스 mujuhoney → 이 레포의 [`slack-reviewer-manifest.yaml`](../slack-reviewer-manifest.yaml) 붙여넣기 → Create
2. **Basic Information → App-Level Tokens → Generate Token**: 이름 `socket`, scope `connections:write` → `xapp-…` 복사
3. **Install App → Install to Workspace** → **Bot User OAuth Token** `xoxb-…` 복사
4. (선택) **Basic Information → Display Information** 에서 아이콘·이름(리비) 설정
5. 앱 채널에는 리뷰어가 처음 글을 쓸 때 스스로 들어가요 (공개 채널). 비공개 채널이면 `/invite @리비`

### 2. 서버에 Codex 설치·로그인

```bash
ssh pipeline-bot
sudo npm install -g @openai/codex
# ChatGPT 계정으로 로그인 (출력된 주소를 Mac 브라우저에서 열고 코드 입력)
sudo -u pipeline -i codex login --device-auth
#   API 키를 쓰려면 대신:  sudo -u pipeline -i bash -c 'read -rs K; printf %s "$K" | codex login --with-api-key'
sudo -u pipeline -i codex login status
# 샌드박스가 이 서버에서 도는지 확인 (읽기 전용으로 한 줄 답하면 OK)
sudo -u pipeline -i bash -c 'cd /tmp && codex exec --sandbox read-only --skip-git-repo-check "pwd 를 실행하고 결과만 말해"'
```

로그인 정보는 `/home/pipeline/.codex/` 에 저장돼요 (봇 사용자만 읽기). 봇이 Codex 를 부를 때 Slack·GitHub·Vercel 토큰은 넘기지 않아요.

### 3. 토큰 넣고 재시작

토큰은 채팅에 붙이지 말고 서버에서 직접 넣어요.

```bash
sudo -u pipeline nano /home/pipeline/pipeline/.env
#   REVIEWER_SLACK_BOT_TOKEN=xoxb-...
#   REVIEWER_SLACK_APP_TOKEN=xapp-...
#   (선택) CODEX_MODEL=        비우면 ~/.codex/config.toml 기본 모델
#   (선택) REVIEW_MAX_ROUNDS=2
sudo systemctl restart pipeline
journalctl -u pipeline -n 20   # "리비(리뷰어, Codex)도 켜졌어요" 가 보이면 끝
```

두 토큰 중 하나라도 비우면 리뷰어는 꺼지고 지금과 똑같이 동작해요.

## 문제가 생기면

- 리비가 `⚠️ 리뷰하지 못했어요` 라고 하면 메시지에 Codex 오류가 붙어 있어요. 로그인 만료면 2단계 `codex login` 을 다시 하세요.
- 샌드박스 오류(`landlock`, `bwrap`, `seccomp` 등)가 나면 서버 커널/systemd 설정 문제예요. 위 확인 명령으로 재현해 보고 알려 주세요. 샌드박스를 끄는 옵션은 쓰지 않아요.
- 리뷰가 너무 잦으면 `REVIEW_MAX_ROUNDS=0` (첫 리뷰만, 자동 반영 없음) 또는 토큰을 비워 끌 수 있어요.
