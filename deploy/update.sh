#!/usr/bin/env bash
# main 의 최신 코드를 받아 봇을 재시작한다:  sudo bash /home/pipeline/pipeline/deploy/update.sh
set -euo pipefail
PIPELINE_USER="${PIPELINE_USER:-pipeline}"
APP_DIR="/home/${PIPELINE_USER}/pipeline"
[[ $EUID -eq 0 ]] || { echo "sudo 로 실행해주세요"; exit 1; }

GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-)
AUTH=(-c "credential.helper=" -c "credential.helper=!f() { echo username=x-access-token; echo password=\$PIPELINE_GH_TOKEN; }; f")

before=$(sudo -u "$PIPELINE_USER" git -C "$APP_DIR" rev-parse --short HEAD)
sudo -u "$PIPELINE_USER" env PIPELINE_GH_TOKEN="$GITHUB_TOKEN" git -C "$APP_DIR" "${AUTH[@]}" pull --ff-only
after=$(sudo -u "$PIPELINE_USER" git -C "$APP_DIR" rev-parse --short HEAD)

if [[ "$before" == "$after" ]]; then
  echo "이미 최신이에요 ($after)."
  exit 0
fi
sudo -u "$PIPELINE_USER" git -C "$APP_DIR" log --oneline "$before..$after"
sudo -u "$PIPELINE_USER" bash -lc "cd '$APP_DIR' && npm ci"
systemctl restart pipeline
echo "✅ $before → $after 로 업데이트하고 재시작했어요. 로그: journalctl -u pipeline -f"
