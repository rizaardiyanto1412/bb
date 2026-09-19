#!/usr/bin/env bash
# Idempotent update of a provisioned Repile VPS. Safe to run on every deploy.
# Single repo: the bb fork checkout at /opt/repile/bb carries repile/ inside.
set -euo pipefail

BB_BRANCH="${BB_BRANCH:-repile}"
CODE_DIR="/opt/repile/bb"
DATA_DIR="/var/lib/repile"

cd "$CODE_DIR"
git remote remove origin 2>/dev/null || true
git fetch fork "$BB_BRANCH" --depth 50
git checkout "$BB_BRANCH"
git reset --hard "fork/$BB_BRANCH"
pnpm install
pnpm build

for plugin in "$CODE_DIR"/repile/plugins/*/; do
  [ -f "$plugin/package.json" ] || continue
  (cd "$plugin" && npm install --no-audit --no-fund)
  BB_DATA_DIR="$DATA_DIR" node packages/bb-app/dist/bb.js plugin install \
    --yes "path:${plugin%/}"
done

systemctl restart repile.service
sleep 10
systemctl is-active repile.service
curl -s -o /dev/null -w "loopback:%{http_code}\n" http://127.0.0.1:38886/
