#!/usr/bin/env bash
# Usage: deploy.sh   (run from anywhere; expects .upstream fetched and built)
# Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN,
#      optional SMOKE_PAT. OpenTofu state access env (backend creds, passphrase) must also be set.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${ASSET_LINK_SECRET:?}" "${DB_SYNC_ADMIN_TOKEN:?}"

upstream=".upstream"
worker_dir="$repo_root/$upstream/deps/db-sync/worker"
wrangler="$repo_root/$upstream/deps/db-sync/node_modules/.bin/wrangler"
settings="config/settings.json"

setting() {
  node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]))' "$settings" "$1"
}
plan="$(setting plan)"
hostname="$(setting hostname)"
d1_name="$(setting d1DatabaseName)"

tofu -chdir=infra output -json > tofu-output.json

node scripts/render-wrangler.mjs \
  --upstream "$worker_dir/wrangler.toml" \
  --settings "$settings" \
  --tofu-outputs tofu-output.json \
  --out "$worker_dir/wrangler.toml" \
  --plan "$plan"

cd "$worker_dir"
"$wrangler" d1 migrations apply "$d1_name" --remote
"$wrangler" deploy

umask 077
secrets_file="$(mktemp)"
trap 'rm -f "$secrets_file"' EXIT
node -e '
  const { ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN } = process.env;
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN }));
' "$secrets_file"
"$wrangler" secret bulk "$secrets_file"

cd "$repo_root"
PLAN="$plan" scripts/smoke-test.sh "https://$hostname"
