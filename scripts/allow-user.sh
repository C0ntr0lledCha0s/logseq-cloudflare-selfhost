#!/usr/bin/env bash
# Claim a fresh sync server for its owner, or add one more person, from the sync Worker's refusal log.
# Usage: allow-user.sh [--owner] [--wait <minutes, default 10>] [--show-ids]   (run from anywhere; needs node and gh)
#   --owner     claim a server whose list is `none` (needs no users on the server yet)
#   --wait      how long to wait for a refused sign-in
#   --show-ids  show each person's ID as well as their email
# Reads CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and SYNC_HOSTNAME from .env.local at the repo root.
# Values already in the environment win over the file. On a yes it edits DB_SYNC_ALLOWED_USERS in
# .env.local (keeping a backup), pushes that secret and runs the deploy. See allow-user.mjs.
# Prints emails, so it refuses to run in GitHub Actions.
# Env (TEST ONLY, with ALLOW_USER_TEST=1): ALLOW_USER_REPO_ROOT, ALLOW_USER_POLL_SECONDS, CF_API_BASE and
# CF_API_TEST (cloudflare-api.mjs).
set -euo pipefail

# Refuse before reading anything, including .env.local. The message matches `allow-user.mjs`.
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "error: allow-user prints emails, so it never runs in GitHub Actions" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
if [ -n "${ALLOW_USER_REPO_ROOT:-}" ]; then
  [ "${ALLOW_USER_TEST:-}" = "1" ] || {
    echo "allow-user: ALLOW_USER_REPO_ROOT is test-only and requires ALLOW_USER_TEST=1" >&2
    exit 1
  }
  repo_root="$ALLOW_USER_REPO_ROOT"
fi

if [ -f "$repo_root/.env.local" ]; then
  # Sourcing overwrites variables, but a value the caller already set must win (an override on the
  # command line, or a test). So save the caller's values for the names allow-user.mjs reads, source the
  # file, then put the saved values back. An empty value counts as unset.
  caller_values=()
  for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN SYNC_HOSTNAME CF_API_BASE CF_API_TEST \
    ALLOW_USER_TEST ALLOW_USER_POLL_SECONDS; do
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

exec node "$script_dir/allow-user.mjs" --repo-root "$repo_root" "$@"
