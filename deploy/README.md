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

## 앱인토스 API 키 넣기

키를 채팅에 붙이지 말고 서버에서 직접 넣어요. 입력이 화면과 셸 기록에 남지 않아요.

```bash
ssh pipeline-bot
sudo -u pipeline bash -c 'read -rsp "앱인토스 API 키: " k; echo; f=/home/pipeline/pipeline/.env; grep -v "^APPS_IN_TOSS_API_KEY=" "$f" > "$f.tmp"; echo "APPS_IN_TOSS_API_KEY=$k" >> "$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"'
sudo systemctl restart pipeline
```
