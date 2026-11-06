#!/usr/bin/env bash
# List the sync server's users (ID, email, username, graph count, and whether each is on
# DB_SYNC_ALLOWED_USERS), to find the ID to put in that list (README section 9).
# Usage: list-users.sh   (run from anywhere; needs node)
# Reads CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and DB_SYNC_ALLOWED_USERS from .env.local at
# the repo root when it exists. Values already in the environment win over the file.
# Prints user IDs and emails, so it refuses to run in GitHub Actions.
# Env (TEST ONLY, with DEPLOY_SYNC_TEST=1): ALLOWED_USERS_API_BASE, see allowed-users.mjs.
set -euo pipefail

# Refuse before reading anything, including .env.local. The message matches `allowed-users.mjs list`.
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "error: list prints user IDs and emails, so it never runs in GitHub Actions" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$repo_root/.env.local" ]; then
  # Sourcing overwrites variables, but a value the caller already set must win (an override on the
  # command line, or a test). So save the caller's values for the names this script uses, source the
  # file, then put the saved values back. An empty value counts as unset.
  caller_values=()
  for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN DB_SYNC_ALLOWED_USERS ALLOWED_USERS_API_BASE DEPLOY_SYNC_TEST; do
    [ -z "${!name:-}" ] || caller_values+=("$name=${!name}")
  done
  set -a
  # shellcheck disable=SC1091
  . "$repo_root/.env.local"
  set +a
  for assignment in "${caller_values[@]+"${caller_values[@]}"}"; do
    declare -x "$assignment"
  done
fi

d1_name="$(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).d1DatabaseName;
  if (typeof value !== "string" || value === "") { console.error("missing setting: d1DatabaseName"); process.exit(1); }
  process.stdout.write(value);
' "$repo_root/config/settings.json")"

exec node "$repo_root/scripts/allowed-users.mjs" list --database "$d1_name"
