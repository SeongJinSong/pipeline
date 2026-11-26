# 서버에 배포하기

맥 대신 상시 켜진 리눅스 서버에서 봇을 돌리는 방법. 코드는 GitHub `main` 에서 받고, 토큰(`.env`)은 서버에만 둡니다.

```
코드 수정 → PR → main 머지 ──▶ 서버: sudo bash deploy/update.sh (git pull → npm ci → 재시작)
```

## 다른 프로그램과 같은 서버라면 (예: auto-trade)

- 봇은 **전용 사용자 `pipeline`** 으로 돌아요. 코드 수정 에이전트(Claude)가 셸을 쓸 수 있어서, 같은 사용자면 다른 프로그램의 키 파일을 읽을 수 있기 때문이에요.
- systemd 설정으로 **다른 사용자의 홈 폴더는 보이지 않고**, 메모리는 최대 2GB, CPU 우선순위는 낮게 잡혀 있어요 ([`pipeline.service`](pipeline.service)).
- 서버 메모리는 여유 2GB 이상을 권장해요 (Next.js 빌드 + Claude Code).
- 다른 프로그램이 `/home` 밖(`/opt` 등)에 있다면 그 폴더 권한이 다른 사용자에게 열려 있지 않은지 확인하세요.

## 처음 설치 (한 번)

1. 맥에서 `.env` 와 설치 스크립트를 서버로 복사
   ```bash
   scp ~/pipeline/.env ~/pipeline/deploy/install.sh <서버>:/tmp/
   ```
2. 서버에서 설치 (Ubuntu/Debian, Amazon Linux 지원). 레포는 `.env` 의 `GITHUB_TOKEN` 으로 받아요.
   ```bash
   sudo useradd --create-home pipeline 2>/dev/null || true
   sudo install -o pipeline -g pipeline -m 600 /tmp/.env /home/pipeline/pipeline.env && rm /tmp/.env
   sudo bash /tmp/install.sh
   ```
3. Claude 로그인 (구독 계정)
   ```bash
   sudo -iu pipeline claude setup-token
   # 출력된 토큰을 /home/pipeline/pipeline/.env 에 추가
   #   CLAUDE_CODE_OAUTH_TOKEN=<토큰>
   ```
4. **맥 봇을 끈 뒤** 서버에서 시작 (둘 다 켜져 있으면 Slack 이벤트가 나뉘어 들어가요)
   ```bash
   sudo systemctl start pipeline
   journalctl -u pipeline -f
   ```

## 업데이트

```bash
sudo bash /home/pipeline/pipeline/deploy/update.sh
```

## 자주 쓰는 명령

| 할 일 | 명령 |
|---|---|
| 상태 | `systemctl status pipeline` |
| 로그 | `journalctl -u pipeline -f` |
| 재시작 | `sudo systemctl restart pipeline` |
| 멈춤 | `sudo systemctl stop pipeline` |
| `.env` 수정 | `sudo -u pipeline nano /home/pipeline/pipeline/.env` 후 재시작 |

## 앱인토스 콘솔 MCP (Slack 에서 콘솔 작업)

Slack `@pipeline 콘솔 …` 과 API 키 없는 번들 업로드는 서버 Claude Code 에 등록한 앱인토스 콘솔 MCP 를 써요. 한 번만 등록·로그인하면 토큰 갱신은 Claude Code 가 해요. 로그인한 토스 계정 권한으로 콘솔에 접근해요.

```bash
ssh pipeline-bot
# 1) 봇 사용자에 등록 (Mac 과 같은 설정)
sudo -u pipeline -i claude mcp add --transport http --client-id mcp-gateway -s user apps-in-toss-console https://mcp.toss.im/adapters/apps-in-toss-console/mcp
# 2) 로그인: 출력된 주소를 Mac 브라우저에서 열고 토스 계정으로 승인 → 마지막에 열리는(안 열려도 됨) 주소창의 localhost 주소를 통째로 복사해 터미널에 붙여 넣기
sudo -u pipeline -i claude mcp login --no-browser apps-in-toss-console
# 3) 확인: ✔ Connected
sudo -u pipeline -i claude mcp get apps-in-toss-console
# 4) 봇에서 켜기
sudo -u pipeline bash -c 'f=/home/pipeline/pipeline/.env; grep -v "^TOSS_CONSOLE_MCP=" "$f" > "$f.tmp"; echo "TOSS_CONSOLE_MCP=true" >> "$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"'
sudo systemctl restart pipeline
```

- 로그인이 풀리면 Slack 답에 다시 로그인하라고 나와요. 2) 만 다시 하면 돼요.
- 토큰은 `/home/pipeline/.claude/` 아래(봇 사용자만 읽기)에 저장돼요. 끊으려면 `sudo -u pipeline -i claude mcp logout apps-in-toss-console`.

## 앱인토스 API 키 넣기 (선택)

콘솔 MCP 를 쓰면 없어도 돼요. 키가 있으면 번들 업로드는 키(`ait deploy`)로 해요. 키는 앱마다 범위가 정해져 있을 수 있어요.

키를 채팅에 붙이지 말고 서버에서 직접 넣어요. 입력이 화면과 셸 기록에 남지 않아요.

```bash
ssh pipeline-bot
sudo -u pipeline bash -c 'read -rsp "앱인토스 API 키: " k; echo; f=/home/pipeline/pipeline/.env; grep -v "^APPS_IN_TOSS_API_KEY=" "$f" > "$f.tmp"; echo "APPS_IN_TOSS_API_KEY=$k" >> "$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"'
sudo systemctl restart pipeline
```
