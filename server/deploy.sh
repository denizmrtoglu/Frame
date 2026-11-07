#!/usr/bin/env bash
# PoC — push Frame to the host and (re)start Frame Server as a systemd user
# service. Run from the repo root, as the non-root user:
#   ./server/deploy.sh <user>@<ip>
# NOTE: a restart ends every terminal running on the server (agents too).
set -euo pipefail
HOST="${1:?usage: server/deploy.sh user@host}"

node server/build-web.js

rsync -az --delete \
  --exclude node_modules --exclude .git \
  --exclude '.frame/worktrees' --exclude '.frame/runtime' \
  ./ "$HOST:frame/"

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd ~/frame
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
cd server
npm install --no-audit --no-fund --loglevel=error
find node_modules/node-pty -name spawn-helper -exec chmod +x {} \;

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/frame-server.service <<UNIT
[Unit]
Description=Frame Server (PoC)
After=network-online.target

[Service]
ExecStart=$(command -v node) %h/frame/server/index.js
WorkingDirectory=%h
Restart=always
RestartSec=2
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user enable frame-server >/dev/null 2>&1
systemctl --user restart frame-server
sleep 3
systemctl --user --no-pager status frame-server | head -5
curl -s -o /dev/null -w "HTTP check: %{http_code} (401 = up, token required)\n" http://127.0.0.1:7777/
REMOTE

echo "Done. Frame Desktop → File › Connect to Server… → $HOST"
