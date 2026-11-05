#!/usr/bin/env bash
# Usage: deploy.sh   (run from anywhere; expects .upstream fetched and built)
# Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN, SYNC_HOSTNAME,
#      DB_SYNC_ALLOWED_USERS (`none` or comma-separated lowercase Logseq user IDs; checked here, not by the
#      required-env list below, so a missing value gets a clear message), optional SMOKE_PAT.
#      OpenTofu state access env (backend creds, passphrase) must also be set.
# Env (TEST ONLY): DEPLOY_SYNC_UPSTREAM overrides the upstream checkout dir (default .upstream) and
#      DEPLOY_SYNC_SKIP_SMOKE=1 skips the smoke test; both are honoured only with DEPLOY_SYNC_TEST=1.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for hook in DEPLOY_SYNC_UPSTREAM DEPLOY_SYNC_SKIP_SMOKE; do
  if [ -n "${!hook:-}" ] && [ "${DEPLOY_SYNC_TEST:-}" != "1" ]; then
    echo "deploy: $hook is test-only and requires DEPLOY_SYNC_TEST=1" >&2
    exit 1
  fi
done

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${ASSET_LINK_SECRET:?}" "${DB_SYNC_ADMIN_TOKEN:?}" "${SYNC_HOSTNAME:?}"

# Before OpenTofu and before any wrangler call: a bad list must stop the deploy while nothing has changed.
node scripts/allowed-users.mjs check-format

upstream="${DEPLOY_SYNC_UPSTREAM:-$repo_root/.upstream}"
worker_dir="$upstream/deps/db-sync/worker"
wrangler="$upstream/deps/db-sync/node_modules/.bin/wrangler"
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

trap 'rm -f "$repo_root/tofu-output.json"' EXIT
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

# After the migrations, so a first-ever deploy already has a users table. Stops the deploy, with
# nothing shipped, when no listed ID is a known user.
(cd "$repo_root" && node scripts/allowed-users.mjs check-known --database "$d1_name")

# The code and all three secrets go up as one version, so a new Worker never runs with a stale list.
umask 077
secrets_file="$(mktemp)"
trap 'rm -f "$secrets_file" "$repo_root/tofu-output.json"' EXIT
node -e '
  const { ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN, DB_SYNC_ALLOWED_USERS } = process.env;
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN, DB_SYNC_ALLOWED_USERS: DB_SYNC_ALLOWED_USERS.trim() }));
' "$secrets_file"
"$wrangler" deploy --secrets-file "$secrets_file"

cd "$repo_root"
if [ "${DEPLOY_SYNC_SKIP_SMOKE:-}" != "1" ]; then
  scripts/smoke-test.sh "https://$SYNC_HOSTNAME"
fi
