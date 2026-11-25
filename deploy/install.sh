#!/usr/bin/env bash
# pipeline 봇을 리눅스 서버에 설치한다 (Ubuntu/Debian, Amazon Linux/RHEL 계열).
# 다른 프로그램(예: auto-trade)과 같은 서버라면 그 파일에 접근할 수 없는 별도 사용자로 돌린다.
#
#   sudo bash deploy/install.sh            # 레포 안에서 실행하거나
#   curl ... | sudo bash                   # 는 쓰지 말고, 내용을 확인한 뒤 실행하세요
#
# 환경변수로 바꿀 수 있는 값
#   PIPELINE_USER (기본 pipeline)  PIPELINE_REPO (기본 SeongJinSong/pipeline)  PIPELINE_BRANCH (기본 main)
set -euo pipefail

PIPELINE_USER="${PIPELINE_USER:-pipeline}"
PIPELINE_REPO="${PIPELINE_REPO:-SeongJinSong/pipeline}"
PIPELINE_BRANCH="${PIPELINE_BRANCH:-main}"
HOME_DIR="/home/${PIPELINE_USER}"
APP_DIR="${HOME_DIR}/pipeline"

[[ $EUID -eq 0 ]] || { echo "sudo 로 실행해주세요: sudo bash deploy/install.sh"; exit 1; }

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

say "1/6 패키지 (git, 빌드 도구, Node 22)"
if command -v apt-get >/dev/null; then
  apt-get update -y
  apt-get install -y git curl ca-certificates build-essential python3
  if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null || command -v yum >/dev/null; then
  PM=$(command -v dnf || command -v yum)
  $PM install -y git gcc-c++ make python3 tar
  if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    $PM install -y nodejs
  fi
else
  echo "apt/dnf/yum 을 찾지 못했어요. git, Node 22+, 빌드 도구를 직접 설치한 뒤 다시 실행하세요."; exit 1
fi
node -v

say "2/6 전용 사용자 ${PIPELINE_USER} (다른 사용자 파일에 접근 불가)"
if ! id "$PIPELINE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$PIPELINE_USER"
fi
chmod 750 "$HOME_DIR"

say "3/6 Claude Code CLI"
if ! command -v claude >/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi
claude --version || true

say "4/6 레포 받기: ${PIPELINE_REPO}@${PIPELINE_BRANCH}"
if [[ ! -f "$APP_DIR/.env" && ! -f "$HOME_DIR/pipeline.env" ]]; then
  cat <<MSG
먼저 맥의 ~/pipeline/.env 를 서버의 ${HOME_DIR}/pipeline.env 로 복사해주세요. 예:
  scp ~/pipeline/.env <서버>:/tmp/pipeline.env
  sudo install -o ${PIPELINE_USER} -g ${PIPELINE_USER} -m 600 /tmp/pipeline.env ${HOME_DIR}/pipeline.env && rm /tmp/pipeline.env
그다음 이 스크립트를 다시 실행하세요.
MSG
  exit 1
fi
ENV_FILE="$APP_DIR/.env"; [[ -f "$ENV_FILE" ]] || ENV_FILE="$HOME_DIR/pipeline.env"
GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
# 비공개 레포라 .env 의 GITHUB_TOKEN 으로 받는다. 토큰은 .git/config 에 남기지 않는다.
AUTH=(-c "credential.helper=" -c "credential.helper=!f() { echo username=x-access-token; echo password=\$PIPELINE_GH_TOKEN; }; f")
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$PIPELINE_USER" env PIPELINE_GH_TOKEN="$GITHUB_TOKEN" \
    git "${AUTH[@]}" clone --branch "$PIPELINE_BRANCH" "https://github.com/${PIPELINE_REPO}.git" "$APP_DIR"
fi
if [[ -f "$HOME_DIR/pipeline.env" && ! -f "$APP_DIR/.env" ]]; then
  install -o "$PIPELINE_USER" -g "$PIPELINE_USER" -m 600 "$HOME_DIR/pipeline.env" "$APP_DIR/.env"
  rm -f "$HOME_DIR/pipeline.env"
fi

say "5/6 의존성 설치"
sudo -u "$PIPELINE_USER" bash -lc "cd '$APP_DIR' && npm ci"

say "6/6 systemd 서비스 등록 (메모리 상한으로 같은 서버의 다른 프로그램 보호)"
sed -e "s#__USER__#${PIPELINE_USER}#g" -e "s#__APP_DIR__#${APP_DIR}#g" \
  "$APP_DIR/deploy/pipeline.service" >/etc/systemd/system/pipeline.service
systemctl daemon-reload
systemctl enable pipeline >/dev/null

cat <<MSG

✅ 설치 끝. 남은 두 가지:

1) Claude 로그인 (구독 계정, 한 번만)
   sudo -iu ${PIPELINE_USER} claude setup-token
   → 출력된 토큰을 ${APP_DIR}/.env 에 한 줄 추가:  CLAUDE_CODE_OAUTH_TOKEN=<토큰>
   (또는 sudo -iu ${PIPELINE_USER} claude 실행 후 /login, 링크를 맥 브라우저에서 열어 코드 붙여넣기)

2) 맥에서 돌던 봇을 끈 뒤(Ctrl+C) 서버에서 시작
   sudo systemctl start pipeline
   journalctl -u pipeline -f        # 로그 보기

업데이트: sudo bash ${APP_DIR}/deploy/update.sh
MSG
