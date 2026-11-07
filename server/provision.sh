#!/usr/bin/env bash
# PoC — one-time host setup, run from your Mac (needs root SSH):
#   ./server/provision.sh root@<ip> <username>
# Installs Node 22 + build tools, creates <username> with your root
# authorized_keys, and lets that user's systemd services run while logged out.
set -euo pipefail
ROOT_HOST="${1:?usage: server/provision.sh root@<ip> <username>}"
USERNAME="${2:?usage: server/provision.sh root@<ip> <username>}"

ssh -o StrictHostKeyChecking=accept-new "$ROOT_HOST" bash -s -- "$USERNAME" <<'REMOTE'
set -euo pipefail
U="$1"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3 make g++ tmux curl rsync ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! id "$U" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$U" >/dev/null
fi
install -d -m 700 -o "$U" -g "$U" "/home/$U/.ssh"
install -m 600 -o "$U" -g "$U" /root/.ssh/authorized_keys "/home/$U/.ssh/authorized_keys"
loginctl enable-linger "$U"
echo "node $(node -v) · user $U ready · linger on"
REMOTE
