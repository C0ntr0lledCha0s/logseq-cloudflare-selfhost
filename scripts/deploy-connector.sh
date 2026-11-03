#!/usr/bin/env bash
# Usage: deploy-connector.sh   (run from anywhere; expects .upstream fetched and built)
# Does nothing when settings.connector.enabled is false. Otherwise deploys the connector Worker.
# Env (only when enabled): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
#      OWNER_GITHUB_USER_ID, COOKIE_ENCRYPTION_KEY, GRAPH_TOKEN_KEY, CONNECTOR_HOSTNAME.
#      OpenTofu state access env (backend creds, passphrase) must also be set.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

settings="config/settings.json"

# connector_setting <key>: prints a string value of settings.connector.<key>, or "true"/"false" for booleans.
# A missing key is an error.
connector_setting() {
  node -e '
    const connector = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).connector;
    const value = connector?.[process.argv[2]];
    if (typeof value === "boolean" || (typeof value === "string" && value !== "")) process.stdout.write(String(value));
    else { console.error("missing setting: connector." + process.argv[2]); process.exit(1); }
  ' "$settings" "$1"
}

enabled="$(connector_setting enabled)"
case "$enabled" in
  false)
    echo "connector disabled"
    exit 0
    ;;
  true) ;;
  *)
    echo "settings.connector.enabled must be true or false" >&2
    exit 1
    ;;
esac

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${GITHUB_CLIENT_ID:?}" "${GITHUB_CLIENT_SECRET:?}" "${OWNER_GITHUB_USER_ID:?}"
: "${COOKIE_ENCRYPTION_KEY:?}" "${GRAPH_TOKEN_KEY:?}" "${CONNECTOR_HOSTNAME:?}"

connector_dir="$repo_root/connector"
wrangler="$connector_dir/node_modules/.bin/wrangler"
d1_name="$(connector_setting d1DatabaseName)"

umask 077
tofu_output="$(mktemp)"
secrets_file="$(mktemp)"
trap 'rm -f "$tofu_output" "$secrets_file" "$connector_dir/wrangler.json"' EXIT

tofu -chdir=infra output -json > "$tofu_output"
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  # Mask the KV and D1 ids so wrangler output can never print them in the public run log.
  node -e '
    const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const key of ["connector_oauth_kv_id", "connector_d1_id"]) {
      const value = out[key]?.value;
      if (typeof value !== "string" || value === "") { console.error("missing tofu output: " + key); process.exit(1); }
      console.log("::add-mask::" + value);
    }
  ' "$tofu_output"
fi

node scripts/render-connector-wrangler.mjs \
  --template connector/wrangler.template.jsonc \
  --settings "$settings" \
  --tofu-outputs "$tofu_output" \
  --out "$connector_dir/wrangler.json" \
  --hostname "$CONNECTOR_HOSTNAME"

cd "$connector_dir"
"$wrangler" d1 migrations apply "$d1_name" --remote
"$wrangler" deploy

node -e '
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, OWNER_GITHUB_USER_ID, COOKIE_ENCRYPTION_KEY, GRAPH_TOKEN_KEY, CONNECTOR_HOSTNAME } = process.env;
  require("fs").writeFileSync(
    process.argv[1],
    JSON.stringify({ GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, OWNER_GITHUB_USER_ID, COOKIE_ENCRYPTION_KEY, GRAPH_TOKEN_KEY, CONNECTOR_HOSTNAME }),
  );
' "$secrets_file"
"$wrangler" secret bulk "$secrets_file"

cd "$repo_root"
scripts/smoke-connector.sh "https://$CONNECTOR_HOSTNAME"
