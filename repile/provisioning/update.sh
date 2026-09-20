#!/usr/bin/env bash
# Idempotent update of a provisioned Repile VPS. Safe to run on every deploy.
# Single repo: the bb fork checkout at /opt/repile/bb carries repile/ inside.
set -euo pipefail

BB_BRANCH="${BB_BRANCH:-main}"
CODE_DIR="/opt/repile/bb"
DATA_DIR="/var/lib/repile"

cd "$CODE_DIR"
git remote remove origin 2>/dev/null || true
git remote set-url fork bb-gh:rizaardiyanto1412/repile.git 2>/dev/null || git remote add fork bb-gh:rizaardiyanto1412/repile.git
 git fetch fork "$BB_BRANCH" --depth 50
git checkout -B "$BB_BRANCH" "fork/$BB_BRANCH"
git reset --hard "fork/$BB_BRANCH"
pnpm install
pnpm build

# Provider login moved into the bundled provider plugins; drop the standalone one.
BB_DATA_DIR="$DATA_DIR" node packages/bb-app/dist/bb.js plugin remove repile-provider-auth --yes 2>/dev/null || true

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
