#!/usr/bin/env bash
# Usage: deploy-connector.sh   (run from anywhere; expects .upstream fetched and built)
# Does nothing unless CONNECTOR_ENABLED is true. Otherwise deploys the connector Worker.
# Env: CONNECTOR_ENABLED: true, or false/unset/empty for off (anything else is an error).
# Env (only when enabled): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
#      OWNER_GITHUB_USER_ID, COOKIE_ENCRYPTION_KEY, GRAPH_TOKEN_KEY, CONNECTOR_HOSTNAME.
#      OpenTofu state access env (backend creds, passphrase) must also be set.
# Env (TEST ONLY): DEPLOY_CONNECTOR_SETTINGS overrides the settings file path; honoured only
#      together with DEPLOY_CONNECTOR_TEST=1.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

settings="config/settings.json"
if [ -n "${DEPLOY_CONNECTOR_SETTINGS:-}" ]; then
  [ "${DEPLOY_CONNECTOR_TEST:-}" = "1" ] || {
    echo "deploy-connector: DEPLOY_CONNECTOR_SETTINGS is test-only and requires DEPLOY_CONNECTOR_TEST=1" >&2
    exit 1
  }
  settings="$DEPLOY_CONNECTOR_SETTINGS"
fi

case "${CONNECTOR_ENABLED:-false}" in
  false)
    echo "connector disabled"
    exit 0
    ;;
  true) ;;
  *)
    echo "deploy-connector: CONNECTOR_ENABLED must be true or false (unset means false)" >&2
    exit 1
    ;;
esac

# connector_setting <key>: prints the non-empty string settings.connector.<key>. A missing key is an error.
connector_setting() {
  node -e '
    const connector = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).connector;
    const value = connector?.[process.argv[2]];
    if (typeof value === "string" && value !== "") process.stdout.write(value);
    else { console.error("missing setting: connector." + process.argv[2]); process.exit(1); }
  ' "$settings" "$1"
}

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${GITHUB_CLIENT_ID:?}" "${GITHUB_CLIENT_SECRET:?}" "${OWNER_GITHUB_USER_ID:?}"
: "${COOKIE_ENCRYPTION_KEY:?}" "${GRAPH_TOKEN_KEY:?}" "${CONNECTOR_HOSTNAME:?}"

# The Worker fails every request unless these match connector/src/config.ts, so check them before
# anything is rendered or deployed (the secrets may have been set by hand). Values are never printed.
connector_hostname_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
[[ ! "$CONNECTOR_HOSTNAME" =~ [A-Z] ]] || {
  echo "deploy-connector: CONNECTOR_HOSTNAME must be lowercase" >&2
  exit 1
}
if [[ ! "$CONNECTOR_HOSTNAME" =~ $connector_hostname_re ]] || [ "${#CONNECTOR_HOSTNAME}" -gt 253 ]; then
  echo "deploy-connector: CONNECTOR_HOSTNAME must be a bare lowercase hostname (no scheme, port, slash, space or trailing dot; at most 253 characters)" >&2
  exit 1
fi
[[ "$OWNER_GITHUB_USER_ID" =~ ^[1-9][0-9]*$ ]] || {
  echo "deploy-connector: OWNER_GITHUB_USER_ID must be a positive integer with no leading zeros" >&2
  exit 1
}

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
    for (const key of ["connector_oauth_kv_id", "connector_kb_index_kv_id", "connector_d1_id"]) {
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
