#!/usr/bin/env bash
# Usage: deploy.sh   (run from anywhere; expects .upstream fetched and built)
# Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN, SYNC_HOSTNAME,
#      optional SMOKE_PAT. OpenTofu state access env (backend creds, passphrase) must also be set.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${ASSET_LINK_SECRET:?}" "${DB_SYNC_ADMIN_TOKEN:?}" "${SYNC_HOSTNAME:?}"

upstream=".upstream"
worker_dir="$repo_root/$upstream/deps/db-sync/worker"
wrangler="$repo_root/$upstream/deps/db-sync/node_modules/.bin/wrangler"
settings="config/settings.json"

setting() {
  node -e '
    const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof value !== "string" || value === "") { console.error("missing setting: " + process.argv[2]); process.exit(1); }
    process.stdout.write(value);
  ' "$settings" "$1"
}
plan="$(setting plan)"
d1_name="$(setting d1DatabaseName)"

trap 'rm -f tofu-output.json' EXIT
tofu -chdir=infra output -json > tofu-output.json
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  # Mask the D1 id so wrangler output can never print it in the public run log.
  d1_id="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).d1_database_id.value)' tofu-output.json)"
  echo "::add-mask::$d1_id"
fi

# Keep a pristine copy (saved once, first run) so re-runs in the same checkout never
# treat a rendered file as the upstream input.
pristine="$worker_dir/wrangler.upstream.toml"
[ -e "$pristine" ] || cp "$worker_dir/wrangler.toml" "$pristine"
node scripts/render-wrangler.mjs \
  --upstream "$pristine" \
  --settings "$settings" \
  --tofu-outputs tofu-output.json \
  --out "$worker_dir/wrangler.toml" \
  --hostname "$SYNC_HOSTNAME" \
  --plan "$plan"

cd "$worker_dir"
"$wrangler" d1 migrations apply "$d1_name" --remote
"$wrangler" deploy

umask 077
secrets_file="$(mktemp)"
trap 'rm -f "$secrets_file" "$repo_root/tofu-output.json"' EXIT
node -e '
  const { ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN } = process.env;
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN }));
' "$secrets_file"
"$wrangler" secret bulk "$secrets_file"

cd "$repo_root"
PLAN="$plan" scripts/smoke-test.sh "https://$SYNC_HOSTNAME"
