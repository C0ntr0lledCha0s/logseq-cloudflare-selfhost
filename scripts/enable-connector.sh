#!/usr/bin/env bash
# Turn the optional connector on in one command, after you have created its GitHub OAuth app.
# Usage: enable-connector.sh   (run from inside your clone; needs gh logged in, node 22+ and a finished setup)
# Steps, in order: hostname, OAuth app details, your GitHub user ID, secrets (init-env.sh, then any
# connector secret still missing on GitHub), the CONNECTOR_ENABLED setting (.env.local and the GitHub
# variable), checks (doctor.sh), deploy. If a check fails, it switches CONNECTOR_ENABLED back in both
# places and stops before the deploy. A value already in .env.local is used as it is and not asked for
# again. Re-running when the connector is already on pushes any missing connector secret, runs the
# checks, deploys if the latest deploy isn't green, and prints the next steps, so a re-run after a
# failed deploy continues.
# CONNECTOR_HOSTNAME, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET can be exported to skip their prompts.
# Secrets never appear in arguments or output: init-env.sh reads them from the environment.
# Prompts and handles secrets, so it refuses to run in GitHub Actions.
# Env (TEST ONLY, with ENABLE_CONNECTOR_TEST=1): ENABLE_CONNECTOR_REPO_ROOT, the root that holds
# .env.local and the scripts it calls.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "error: enable-connector asks for secrets, so it never runs in GitHub Actions" >&2
  exit 1
fi
if [ "$#" -ne 0 ]; then
  echo "usage: enable-connector.sh" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${ENABLE_CONNECTOR_REPO_ROOT:-}" ]; then
  [ "${ENABLE_CONNECTOR_TEST:-}" = "1" ] || {
    echo "enable-connector: ENABLE_CONNECTOR_REPO_ROOT is test-only and requires ENABLE_CONNECTOR_TEST=1" >&2
    exit 1
  }
  repo_root="$ENABLE_CONNECTOR_REPO_ROOT"
fi
scripts="$repo_root/scripts"
env_file="$repo_root/.env.local"
cd "$repo_root"

fail() {
  echo "$*" >&2
  exit 1
}

# origin_repo, gh_try and gh_must (stdin closed on every gh call, 404 and 403 told apart) live in lib/gh.sh.
# shellcheck source=lib/gh.sh
. "$scripts/lib/gh.sh"

# Reads NAME from .env.local into env_val. Returns 3 when the name isn't in the file; any other
# failure (such as a name that appears twice) stops with env-file.mjs's message.
env_val=""
env_get() {
  local errfile msg
  errfile="$(mktemp)"
  if env_val="$(node "$scripts/env-file.mjs" get "$1" --file "$env_file" 2>"$errfile")"; then
    rm -f "$errfile"
    return 0
  fi
  msg="$(cat "$errfile")"
  rm -f "$errfile"
  case "$msg" in
    *" is not in "*) return 3 ;;
    *) fail "${msg#error: }" ;;
  esac
}

doctor_failed="fix the FAIL lines above, then re-run scripts/enable-connector.sh"
deploy_failed="the deploy didn't succeed: fix what it reported, then re-run scripts/enable-connector.sh"
push_failed="init-env.sh failed: fix what it reported, then re-run scripts/enable-connector.sh"

# Pushes the connector secrets that are missing from the production environment, from .env.local. A
# push that failed part-way on an earlier run left the values in .env.local, where init-env.sh
# --add-missing finds nothing to add, so only this finishes it. Names are compared, never values.
push_missing_secrets() {
  local present name secret missing=()
  gh_must gh secret list --env production --json name -R "$repo"
  present="$(printf '%s' "$gh_out" | node -e 'for (const x of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(x.name)')"
  for name in CONNECTOR_HOSTNAME GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET OWNER_GITHUB_USER_ID COOKIE_ENCRYPTION_KEY GRAPH_TOKEN_KEY; do
    # GitHub forbids secret names starting with GITHUB_, so init-env.sh stores these two under CONNECTOR_.
    secret="$name"
    case "$name" in GITHUB_CLIENT_ID | GITHUB_CLIENT_SECRET) secret="CONNECTOR_$name" ;; esac
    printf '%s\n' "$present" | grep -Fxq -- "$secret" || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "pushing ${missing[*]}"
    "$scripts/init-env.sh" --push-only "${missing[@]}" || fail "$push_failed"
  fi
}

next_steps() {
  cat <<TEXT

The connector is on. To add it to claude.ai:
  1. Open Settings > Connectors > Add custom connector.
  2. Name it Logseq and give the URL https://$connector_host/mcp
     Leave the advanced OAuth client ID and secret empty.
  3. Click Connect and sign in to GitHub with the account that owns this install.
  4. Enable the connector in a conversation and ask "list my Logseq graphs".
Then open https://$connector_host/graphs to connect your graphs (README 11.7).
Claude Code on your own machine: claude mcp add --transport http logseq https://$connector_host/mcp
TEXT
}

# ---- Prerequisites ----
[ -f "$env_file" ] || fail "there is no .env.local here: run scripts/setup.sh first"
command -v gh >/dev/null 2>&1 || fail "install gh (https://cli.github.com) and run gh auth login"
repo="$(origin_repo "$repo_root")" || fail "couldn't read the origin remote's repo from gh: run gh auth status"

# ---- 1. Already on? ----
rc=0
env_get CONNECTOR_ENABLED || rc=$?
[ "$rc" -eq 0 ] || fail "CONNECTOR_ENABLED isn't in .env.local: add the line CONNECTOR_ENABLED=false (see .env.local.example), then re-run"
local_enabled="$env_val"
# CONNECTOR_ENABLED as the deploy reads it: the production environment variable, else the repository
# variable, else false. The lists are read rather than `gh variable get`, whose "not found" for an
# unset variable is not a 404. A missing production environment (a 404) holds no variables.
rc=0
gh_try gh variable list --env production --json name,value -R "$repo" || rc=$?
env_variables="[]"
[ "$rc" -ne 0 ] || env_variables="$gh_out"
gh_must gh variable list --json name,value -R "$repo"
github_enabled="$(ENV_VARIABLES="$env_variables" REPO_VARIABLES="$gh_out" node -e '
  const find = (list) => JSON.parse(list).find((v) => v.name === "CONNECTOR_ENABLED");
  console.log((find(process.env.ENV_VARIABLES) ?? find(process.env.REPO_VARIABLES))?.value || "false");
')"
if [ "$local_enabled" = "true" ] && [ "$github_enabled" = "true" ]; then
  # A failed deploy leaves both switches on, so its re-run lands here: carry on from the secrets and
  # checks, and deploy only if the latest deploy isn't green.
  echo "the connector is already on"
  rc=0
  env_get CONNECTOR_HOSTNAME || rc=$?
  [ "$rc" -eq 0 ] && [ -n "$env_val" ] || fail "CONNECTOR_HOSTNAME isn't set in .env.local: set it to the connector's hostname, then re-run"
  connector_host="$env_val"
  push_missing_secrets
  "$scripts/doctor.sh" || fail "$doctor_failed"
  "$scripts/run-deploy.sh" --if-not-green || fail "$deploy_failed"
  next_steps
  exit 0
fi

env_get SYNC_HOSTNAME || fail "SYNC_HOSTNAME isn't in .env.local: run scripts/setup.sh first"
sync_hostname="$env_val"

# ---- 2. Hostname ----
rc=0
env_get CONNECTOR_HOSTNAME || rc=$?
if [ "$rc" -eq 0 ]; then
  [ -n "$env_val" ] || fail "CONNECTOR_HOSTNAME is empty in .env.local: fill it in, then re-run"
  connector_host="$env_val"
else
  connector_host="${CONNECTOR_HOSTNAME:-}"
  if [ -z "$connector_host" ]; then
    read -rp "Connector hostname (e.g. mcp.example.com): " connector_host || true
  fi
fi
connector_host="$(printf '%s' "$connector_host" | tr '[:upper:]' '[:lower:]')"
[ -n "$connector_host" ] || fail "the connector hostname is required"
case "$sync_hostname" in
  *.*) zone="${sync_hostname#*.}" ;;
  *) fail "SYNC_HOSTNAME in .env.local has no domain part: fix it, then re-run" ;;
esac
case "$connector_host" in
  *".$zone") ;;
  *) fail "the connector hostname must be in the same domain as $zone" ;;
esac

# ---- 3. OAuth app ----
cat <<TEXT
Create a GitHub OAuth app at https://github.com/settings/applications/new with:
  Application name:            Logseq connector
  Homepage URL:                https://$connector_host
  Authorization callback URL:  https://$connector_host/callback
TEXT
rc=0
env_get GITHUB_CLIENT_ID || rc=$?
if [ "$rc" -ne 0 ]; then
  client_id="${GITHUB_CLIENT_ID:-}"
  if [ -z "$client_id" ]; then
    read -rp "GitHub OAuth app client ID: " client_id || true
  fi
  [ -n "$client_id" ] || fail "the GitHub OAuth app client ID is required"
  export GITHUB_CLIENT_ID="$client_id"
fi
rc=0
env_get GITHUB_CLIENT_SECRET || rc=$?
if [ "$rc" -ne 0 ]; then
  client_secret="${GITHUB_CLIENT_SECRET:-}"
  if [ -z "$client_secret" ]; then
    read -rsp "GitHub OAuth app client secret: " client_secret || true
    [ ! -t 0 ] || echo >&2
  fi
  [ -n "$client_secret" ] || fail "the GitHub OAuth app client secret is required"
  export GITHUB_CLIENT_SECRET="$client_secret"
  client_secret=""
fi

# ---- 4. Owner ID ----
rc=0
env_get OWNER_GITHUB_USER_ID || rc=$?
if [ "$rc" -ne 0 ]; then
  gh_must gh api user -q .id
  owner_id="$gh_out"
  gh_must gh api user -q .login
  echo "Owner: $gh_out (from gh)"
  export OWNER_GITHUB_USER_ID="$owner_id"
fi

# ---- 5. Secrets ----
export CONNECTOR_HOSTNAME="$connector_host"
"$scripts/init-env.sh" --add-missing --push || fail "$push_failed"
push_missing_secrets

# ---- 6. Settings and checks ----
# doctor checks the connector (KV permission, its hostname) only with the switch on, so the switch is
# set first. If a check fails, .env.local goes back as it was and the production variable to false,
# before any deploy: left on, the next merge to main would deploy the connector, and wrangler would
# replace any DNS record at its hostname. The re-run then takes this full path again.
switched="$(ENV_FILE_VALUE=true node "$scripts/env-file.mjs" set CONNECTOR_ENABLED --file "$env_file")"
echo "$switched"
env_backup="$repo_root/$(printf '%s' "$switched" | sed -n 's/.*(backup: \(.*\))$/\1/p')"
[ -f "$env_backup" ] || fail "env-file.mjs didn't name the backup of .env.local it made"
gh_must gh variable set CONNECTOR_ENABLED --env production --body true -R "$repo"
if ! "$scripts/doctor.sh"; then
  cp "$env_backup" "$env_file"
  chmod 600 "$env_file"
  gh_must gh variable set CONNECTOR_ENABLED --env production --body false -R "$repo"
  fail "$doctor_failed. It switched the connector off again: .env.local is back as it was (from $(basename "$env_backup")) and the production CONNECTOR_ENABLED variable is false, so no deploy turns it on before the checks pass."
fi

# ---- 7. Deploy ----
"$scripts/run-deploy.sh" || fail "$deploy_failed"

# ---- 8. Next steps ----
next_steps
