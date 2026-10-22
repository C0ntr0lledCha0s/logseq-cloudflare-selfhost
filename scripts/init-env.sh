#!/usr/bin/env bash
# Generate .env.local: you supply the Cloudflare API token, the Cloudflare account ID and
# your sync hostname; the other three secrets are generated with `openssl rand -hex 32`.
# Usage: init-env.sh [--push]   (run from anywhere)
#   --push  also copy the values into the GitHub `production` environment with `gh secret set`
#           (value on stdin only).
# Input: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SYNC_HOSTNAME are read from the environment
#   when set, otherwise prompted for on the terminal (the token silently).
# Env (TEST ONLY): INIT_ENV_REPO_ROOT overrides the repo root (where .env.local is written and
#   .env.local.example is read); honoured only together with INIT_ENV_TEST=1.
# Never prints secret values and never overwrites an existing .env.local.
set -euo pipefail

push=0
case "${1:-}" in
  "") ;;
  --push) push=1 ;;
  *)
    echo "usage: init-env.sh [--push]" >&2
    exit 2
    ;;
esac
[ "$#" -le 1 ] || {
  echo "usage: init-env.sh [--push]" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${INIT_ENV_REPO_ROOT:-}" ]; then
  [ "${INIT_ENV_TEST:-}" = "1" ] || {
    echo "init-env: INIT_ENV_REPO_ROOT is test-only and requires INIT_ENV_TEST=1" >&2
    exit 1
  }
  repo_root="$INIT_ENV_REPO_ROOT"
fi

env_file="$repo_root/.env.local"
template="$repo_root/.env.local.example"

[ ! -e "$env_file" ] || {
  echo "init-env: $env_file already exists; move it aside first (it is never overwritten)" >&2
  exit 1
}
[ -f "$template" ] || {
  echo "init-env: missing $template" >&2
  exit 1
}
if [ "$push" = 1 ]; then
  command -v gh >/dev/null || {
    echo "init-env: --push requires the GitHub CLI (gh)" >&2
    exit 1
  }
fi

command -v openssl >/dev/null || {
  echo "init-env: openssl is required" >&2
  exit 1
}

# Fill any of the three inputs not already in the environment from the terminal.
if [ ! -t 0 ] && { [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${SYNC_HOSTNAME:-}" ]; }; then
  echo "init-env: no terminal: export CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SYNC_HOSTNAME" >&2
  exit 1
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN
  echo
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  read -rp "Cloudflare account ID: " CLOUDFLARE_ACCOUNT_ID
fi
if [ -z "${SYNC_HOSTNAME:-}" ]; then
  read -rp "Sync hostname (e.g. sync.example.com): " SYNC_HOSTNAME
fi

[[ "$CLOUDFLARE_API_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "init-env: CLOUDFLARE_API_TOKEN has unexpected characters (stray whitespace or newline?)" >&2
  exit 1
}
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "init-env: CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters" >&2
  exit 1
}
[[ "$SYNC_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || {
  echo "init-env: SYNC_HOSTNAME must be a bare hostname like sync.example.com (no scheme, slash or space)" >&2
  exit 1
}

ASSET_LINK_SECRET="$(openssl rand -hex 32)"
DB_SYNC_ADMIN_TOKEN="$(openssl rand -hex 32)"
TOFU_ENCRYPTION_PASSPHRASE="$(openssl rand -hex 32)"

# Fill the template's `NAME=` lines. Values reach awk through its environment, not argv.
umask 077
set -o noclobber
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
  ASSET_LINK_SECRET="$ASSET_LINK_SECRET" DB_SYNC_ADMIN_TOKEN="$DB_SYNC_ADMIN_TOKEN" \
  TOFU_ENCRYPTION_PASSPHRASE="$TOFU_ENCRYPTION_PASSPHRASE" SYNC_HOSTNAME="$SYNC_HOSTNAME" \
  awk '
    /^[A-Z_]+=$/ {
      name = substr($0, 1, length($0) - 1)
      if (name ~ /^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|ASSET_LINK_SECRET|DB_SYNC_ADMIN_TOKEN|TOFU_ENCRYPTION_PASSPHRASE|SYNC_HOSTNAME)$/) { print name "=" ENVIRON[name]; next }
    }
    { print }
  ' "$template" >"$env_file"
set +o noclobber

echo "Wrote $env_file (mode 600). Generated ASSET_LINK_SECRET, DB_SYNC_ADMIN_TOKEN and TOFU_ENCRYPTION_PASSPHRASE."

if [ "$push" = 1 ]; then
  recovery="init-env: .env.local was written; re-run the push with the README 1.8 loop"
  # Target the repo that owns this checkout, whatever the current directory is.
  target_repo="$(cd "$repo_root" && gh repo view --json nameWithOwner -q .nameWithOwner)" || {
    echo "init-env: could not determine the GitHub repo for $repo_root" >&2
    echo "$recovery" >&2
    exit 1
  }
  [ -n "$target_repo" ] || {
    echo "init-env: could not determine the GitHub repo for $repo_root" >&2
    echo "$recovery" >&2
    exit 1
  }
  echo "Pushing secrets to $target_repo (environment: production)"
  gh api "repos/$target_repo/environments/production" >/dev/null || {
    echo "init-env: environment 'production' not found in $target_repo; create it first (README 1.8)" >&2
    echo "$recovery" >&2
    exit 1
  }
  for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE \
    ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN SYNC_HOSTNAME; do
    printf '%s' "${!name}" | gh secret set "$name" -R "$target_repo" --env production || {
      echo "init-env: failed to set $name" >&2
      echo "$recovery" >&2
      exit 1
    }
  done
  echo "Pushed 6 secrets to the GitHub production environment."
fi

echo
echo "Next:"
echo "  - Copy TOFU_ENCRYPTION_PASSPHRASE from .env.local into your password manager — without it the OpenTofu state can't be decrypted."
if [ "$push" != 1 ]; then
  echo "  - Copy the values to the GitHub production environment (README 1.8)."
fi
