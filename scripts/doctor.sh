#!/usr/bin/env bash
# Check the Cloudflare account, token, domain, GitHub repo and local files, changing nothing.
# Usage: doctor.sh   (run from anywhere; needs node, and gh for the GitHub checks)
# Reads .env.local at the repo root. Values already in the environment win over the file.
# Prints one line per check (ok, warn or FAIL) and exits 1 if any check failed. See doctor.mjs.
# Env (TEST ONLY, with DOCTOR_TEST=1): DOCTOR_REPO_ROOT, CF_API_BASE and CF_API_TEST (cloudflare-api.mjs).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
if [ -n "${DOCTOR_REPO_ROOT:-}" ]; then
  [ "${DOCTOR_TEST:-}" = "1" ] || {
    echo "doctor: DOCTOR_REPO_ROOT is test-only and requires DOCTOR_TEST=1" >&2
    exit 1
  }
  repo_root="$DOCTOR_REPO_ROOT"
fi

if [ ! -f "$repo_root/.env.local" ]; then
  echo "doctor: no .env.local; run scripts/setup.sh first" >&2
  exit 1
fi

# Sourcing overwrites variables, but a value the caller already set must win (an override on the
# command line, or a test). So save the caller's values for every name doctor.mjs reads, source the
# file, then put the saved values back. An empty value counts as unset.
caller_values=()
for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN SYNC_HOSTNAME CONNECTOR_HOSTNAME CONNECTOR_ENABLED \
  SEMANTIC_SEARCH_ENABLED DB_SYNC_ALLOWED_USERS CF_API_BASE CF_API_TEST; do
  [ -z "${!name:-}" ] || caller_values+=("$name=${!name}")
done
set -a
# shellcheck disable=SC1091
. "$repo_root/.env.local"
set +a
for assignment in "${caller_values[@]+"${caller_values[@]}"}"; do
  declare -x "$assignment"
done

exec node "$script_dir/doctor.mjs" --repo-root "$repo_root"
