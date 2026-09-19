#!/usr/bin/env bash
# Fresh VPS provisioning for one Repile workspace. Tested on Debian 13.
# Usage: DOMAIN=repile.example.com BASIC_USER=riza ./provision.sh
# Single repo: clone the fork branch, then hand off to update.sh.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN}"
BASIC_USER="${BASIC_USER:-riza}"
BB_FORK="${BB_FORK:-bb-gh:rizaardiyanto1412/bb.git}"
BB_BRANCH="${BB_BRANCH:-repile}"
CODE_DIR="/opt/repile/bb"
DATA_DIR="/var/lib/repile"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git build-essential python3 curl openssl \
  debian-keyring debian-archive-keyring apt-transport-https

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm i -g pnpm@9

curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

if [ ! -d "$CODE_DIR/.git" ]; then
  mkdir -p "$(dirname "$CODE_DIR")"
  git clone --branch "$BB_BRANCH" --depth 50 "$BB_FORK" "$CODE_DIR"
fi

npm i -g @openai/codex@0.155.1 @anthropic-ai/claude-code@2.1.278

mkdir -p "$DATA_DIR"
sed -e "s#__DATA_DIR__#$DATA_DIR#" /dev/stdin > /etc/systemd/system/repile.service <<'UNIT'
[Unit]
Description=Repile bb server and host daemon
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=/opt/repile/bb
Environment=BB_DATA_DIR=__DATA_DIR__
Environment=BB_SERVER_PORT=38886
Environment=BB_HOST_DAEMON_PORT=38887
Environment=BB_SERVER_BIND_HOST=127.0.0.1
Environment=NODE_ENV=production
ExecStart=/usr/bin/node packages/bb-app/dist/bb-app.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable repile.service

PASS_FILE=/root/.repile-basic-auth
if [ ! -f "$PASS_FILE" ]; then
  openssl rand -base64 18 > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
fi
HASH=$(caddy hash-password < "$PASS_FILE")
printf '%s {\n\tbasic_auth {\n\t\t%s %s\n\t}\n\treverse_proxy 127.0.0.1:38886\n}\n' \
  "$DOMAIN" "$BASIC_USER" "$HASH" > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
systemctl reload caddy

BB_BRANCH="$BB_BRANCH" bash "$CODE_DIR/repile/provisioning/update.sh"

echo "OK. Login user: $BASIC_USER. Password: cat $PASS_FILE on this host."
