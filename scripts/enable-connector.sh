#!/usr/bin/env bash
# Turn the optional connector on in one command, after you have created its GitHub OAuth app.
# Usage: enable-connector.sh   (run from inside your clone; needs gh logged in, node 22+ and a finished setup)
# Steps, in order: hostname, OAuth app details, your GitHub user ID, secrets (init-env.sh), the
# CONNECTOR_ENABLED setting (.env.local and the GitHub variable), checks (doctor.sh), deploy.
# It stops before the deploy if a check fails. A value already in .env.local is used as it is and not
# asked for again, so re-running after a failure continues from where it stopped.
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

# Every gh call has stdin closed, so none can prompt or take what the user types for this script's questions.
# (Same helper as setup.sh.) Runs a gh command, keeping its output in gh_out and its error in gh_err.
# Returns 0 on success and 4 for a 404 (the caller decides what that means). A 403 stops with the admin
# message, and any other failure stops with gh's own message.
gh_out=""
gh_err=""
gh_try() {
  local errfile
  errfile="$(mktemp)"
  if gh_out="$("$@" 2>"$errfile" </dev/null)"; then
    rm -f "$errfile"
    return 0
  fi
  gh_err="$(cat "$errfile")"
  rm -f "$errfile"
  case "$gh_err" in
    *"HTTP 404"*) return 4 ;;
    *"HTTP 403"*)
      local login
      login="$(gh api user -q .login 2>/dev/null </dev/null || true)"
      fail "gh is logged in as ${login:-unknown} (gh api user -q .login), which can't change settings on $repo: it needs admin on the repo."
      ;;
    *) fail "$gh_err" ;;
  esac
}
# Like gh_try, but a 404 stops too.
gh_must() {
  local rc=0
  gh_try "$@" || rc=$?
  [ "$rc" -eq 0 ] || fail "$gh_err"
}

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

# ---- Prerequisites ----
[ -f "$env_file" ] || fail "there is no .env.local here: run scripts/setup.sh first"
command -v gh >/dev/null 2>&1 || fail "install gh (https://cli.github.com) and run gh auth login"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner </dev/null)" || fail "couldn't read this repo from gh: run gh auth status"

# ---- 1. Already on? ----
rc=0
env_get CONNECTOR_ENABLED || rc=$?
[ "$rc" -eq 0 ] || fail "CONNECTOR_ENABLED isn't in .env.local: add the line CONNECTOR_ENABLED=false (see .env.local.example), then re-run"
local_enabled="$env_val"
rc=0
gh_try gh variable get CONNECTOR_ENABLED --env production -R "$repo" || rc=$?
github_enabled=""
[ "$rc" -ne 0 ] || github_enabled="$gh_out"
if [ "$local_enabled" = "true" ] && [ "$github_enabled" = "true" ]; then
  echo "the connector is already on"
  echo "If its last deploy failed, run scripts/doctor.sh and then scripts/run-deploy.sh."
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
connector_host="${connector_host,,}"
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
"$scripts/init-env.sh" --add-missing --push || fail "init-env.sh failed: fix what it reported, then re-run scripts/enable-connector.sh"

# ---- 6. Settings and checks ----
ENV_FILE_VALUE=true node "$scripts/env-file.mjs" set CONNECTOR_ENABLED --file "$env_file"
gh_must gh variable set CONNECTOR_ENABLED --env production --body true -R "$repo"
if ! "$scripts/doctor.sh"; then
  fail "fix the FAIL lines above, then run scripts/doctor.sh again and, when it passes, scripts/run-deploy.sh (re-running this script would say the connector is already on)"
fi

# ---- 7. Deploy ----
"$scripts/run-deploy.sh" || fail "the deploy didn't succeed: fix what it reported, then run scripts/run-deploy.sh"

# ---- 8. Next steps ----
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
