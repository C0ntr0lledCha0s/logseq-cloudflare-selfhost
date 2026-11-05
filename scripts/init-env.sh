#!/usr/bin/env bash
# Generate .env.local: you supply the Cloudflare API token, the Cloudflare account ID and
# your sync hostname; the other three secrets are generated with `openssl rand -hex 32`.
# DB_SYNC_ALLOWED_USERS (who may use the server) starts as `none`, which refuses everyone.
# Usage: init-env.sh [--add-missing] [--push]   (run from anywhere)
#   --push         also copy the values into the GitHub `production` environment with
#                  `gh secret set` (value on stdin only).
#   --add-missing  for an existing .env.local: append, in one marked block, only the names it
#                  lacks among the original six, DB_SYNC_ALLOWED_USERS (never generated: your
#                  Logseq user ID(s), comma-separated, or none; checked with
#                  `allowed-users.mjs check-format`) plus the optional connector's CONNECTOR_HOSTNAME,
#                  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (read silently), OWNER_GITHUB_USER_ID,
#                  COOKIE_ENCRYPTION_KEY and GRAPH_TOKEN_KEY (the last two generated). Existing
#                  lines are never rewritten. With --push, only the newly added names are pushed.
#                  A name that is present but empty is an error: fill it by hand.
#                  TOFU_ENCRYPTION_PASSPHRASE, ASSET_LINK_SECRET and DB_SYNC_ADMIN_TOKEN are never
#                  generated in this mode: if one is missing, nothing is written or pushed (restore it).
# Input: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SYNC_HOSTNAME (and, with --add-missing and
#   when missing, the four connector inputs and DB_SYNC_ALLOWED_USERS) are read from the environment when set, otherwise
#   prompted for on the terminal (the token and the GitHub client secret silently). A fresh run
#   takes DB_SYNC_ALLOWED_USERS from the template (`none`), never from the environment.
# Env (TEST ONLY): INIT_ENV_REPO_ROOT overrides the repo root (where .env.local is written and
#   .env.local.example is read); honoured only together with INIT_ENV_TEST=1.
# Never prints secret values and never overwrites an existing .env.local (--add-missing only appends).
set -euo pipefail

usage="usage: init-env.sh [--add-missing] [--push]"
push=0
add_missing=0
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    --add-missing) add_missing=1 ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
if [ -n "${INIT_ENV_REPO_ROOT:-}" ]; then
  [ "${INIT_ENV_TEST:-}" = "1" ] || {
    echo "init-env: INIT_ENV_REPO_ROOT is test-only and requires INIT_ENV_TEST=1" >&2
    exit 1
  }
  repo_root="$INIT_ENV_REPO_ROOT"
fi

env_file="$repo_root/.env.local"
template="$repo_root/.env.local.example"

if [ "$add_missing" = 1 ]; then
  [ -f "$env_file" ] || {
    echo "init-env: --add-missing needs an existing $env_file; run without it to create one" >&2
    exit 1
  }
else
  [ ! -e "$env_file" ] || {
    echo "init-env: $env_file already exists; move it aside first (it is never overwritten; --add-missing appends)" >&2
    exit 1
  }
  [ -f "$template" ] || {
    echo "init-env: missing $template" >&2
    exit 1
  }
fi
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

original_names="CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN SYNC_HOSTNAME"
connector_names="CONNECTOR_HOSTNAME GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET OWNER_GITHUB_USER_ID COOKIE_ENCRYPTION_KEY GRAPH_TOKEN_KEY"
# Not a credential and never generated: who may use the server.
allowed_users_name="DB_SYNC_ALLOWED_USERS"
generated_names="ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN TOFU_ENCRYPTION_PASSPHRASE COOKIE_ENCRYPTION_KEY GRAPH_TOKEN_KEY"
# Names to write, in order. A fresh run writes the original six and DB_SYNC_ALLOWED_USERS;
# --add-missing the absent ones.
add_names=""
if [ "$add_missing" = 1 ]; then
  for name in $original_names $connector_names $allowed_users_name; do
    # `NAME=`, `export NAME=` and an indented `NAME=` all count as present.
    if ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?$name=" "$env_file"; then
      add_names="$add_names $name"
    elif grep -Eq "^[[:space:]]*(export[[:space:]]+)?$name=$" "$env_file"; then
      echo "init-env: $name is present but empty in $env_file; fill it by hand (--add-missing never rewrites lines)" >&2
      exit 1
    fi
  done
  # A new value for these would not match the deployed one (and a new passphrase cannot decrypt
  # the OpenTofu state), so they must be restored, never regenerated.
  state_missing=0
  for name in TOFU_ENCRYPTION_PASSPHRASE ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN; do
    case "$add_names " in
      *" $name "*)
        state_missing=1
        case "$name" in
          TOFU_ENCRYPTION_PASSPHRASE) why="generating a new one locks you out of the OpenTofu state" ;;
          *) why="generating a new one would not match the value the deployed sync Worker uses" ;;
        esac
        echo "init-env: $name is missing from .env.local — restore it from your password manager; $why" >&2
        ;;
    esac
  done
  if [ "$state_missing" = 1 ]; then
    echo "init-env: nothing was written or pushed" >&2
    exit 1
  fi
else
  add_names=" $original_names $allowed_users_name"
  # The template carries the value (`none`): the written file and the push use it as it is.
  DB_SYNC_ALLOWED_USERS="$(sed -n 's/^DB_SYNC_ALLOWED_USERS=//p' "$template")"
  [ -n "$DB_SYNC_ALLOWED_USERS" ] || {
    echo "init-env: $template has no DB_SYNC_ALLOWED_USERS= value" >&2
    exit 1
  }
fi

# Inputs to collect: the written names that are not generated, in prompt order.
need_inputs=""
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID SYNC_HOSTNAME CONNECTOR_HOSTNAME \
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET OWNER_GITHUB_USER_ID; do
  case "$add_names " in *" $name "*) need_inputs="$need_inputs $name" ;; esac
done
# A fresh run takes DB_SYNC_ALLOWED_USERS from the template; --add-missing asks for it.
if [ "$add_missing" = 1 ]; then
  case "$add_names " in *" $allowed_users_name "*) need_inputs="$need_inputs $allowed_users_name" ;; esac
fi

# Fill any input not already in the environment from the terminal.
if [ ! -t 0 ]; then
  unset_inputs=""
  for name in $need_inputs; do
    [ -n "${!name:-}" ] || unset_inputs="$unset_inputs $name"
  done
  if [ -n "$unset_inputs" ]; then
    # A fresh run keeps listing all three inputs; --add-missing lists only the unset ones.
    listed="$need_inputs"
    [ "$add_missing" != 1 ] || listed="$unset_inputs"
    list=""
    for name in $listed; do list="$list, $name"; done
    echo "init-env: no terminal: export ${list#, }" >&2
    exit 1
  fi
fi
# The values are used through indirect expansion (${!name}) below.
# shellcheck disable=SC2034
for name in $need_inputs; do
  [ -z "${!name:-}" ] || continue
  case "$name" in
    CLOUDFLARE_API_TOKEN) read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN; echo ;;
    CLOUDFLARE_ACCOUNT_ID) read -rp "Cloudflare account ID: " CLOUDFLARE_ACCOUNT_ID ;;
    SYNC_HOSTNAME) read -rp "Sync hostname (e.g. sync.example.com): " SYNC_HOSTNAME ;;
    CONNECTOR_HOSTNAME) read -rp "Connector hostname (e.g. mcp.example.com): " CONNECTOR_HOSTNAME ;;
    GITHUB_CLIENT_ID) read -rp "GitHub OAuth app client ID: " GITHUB_CLIENT_ID ;;
    GITHUB_CLIENT_SECRET) read -rsp "GitHub OAuth app client secret: " GITHUB_CLIENT_SECRET; echo ;;
    OWNER_GITHUB_USER_ID) read -rp "Your numeric GitHub user ID: " OWNER_GITHUB_USER_ID ;;
    DB_SYNC_ALLOWED_USERS) read -rp "Logseq user ID(s), comma-separated, or none (find yours with scripts/list-users.sh): " DB_SYNC_ALLOWED_USERS ;;
  esac
done

hostname_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
connector_hostname_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
for name in $need_inputs; do
  value="${!name}"
  case "$name" in
    CLOUDFLARE_API_TOKEN)
      [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || {
        echo "init-env: CLOUDFLARE_API_TOKEN has unexpected characters (stray whitespace or newline?)" >&2
        exit 1
      }
      ;;
    CLOUDFLARE_ACCOUNT_ID)
      [[ "$value" =~ ^[0-9a-f]{32}$ ]] || {
        echo "init-env: CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters" >&2
        exit 1
      }
      ;;
    SYNC_HOSTNAME)
      [[ "$value" =~ $hostname_re ]] || {
        echo "init-env: $name must be a bare hostname like sync.example.com (no scheme, slash or space)" >&2
        exit 1
      }
      ;;
    CONNECTOR_HOSTNAME)
      # The connector Worker accepts only this form (connector/src/config.ts) and fails every request otherwise.
      [[ ! "$value" =~ [A-Z] ]] || {
        echo "init-env: CONNECTOR_HOSTNAME must be lowercase (e.g. mcp.example.com)" >&2
        exit 1
      }
      if [[ ! "$value" =~ $connector_hostname_re ]] || [ "${#value}" -gt 253 ]; then
        echo "init-env: CONNECTOR_HOSTNAME must be a bare lowercase hostname like mcp.example.com (no scheme, port, slash, space or trailing dot; at most 253 characters)" >&2
        exit 1
      fi
      ;;
    GITHUB_CLIENT_ID | GITHUB_CLIENT_SECRET)
      [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]] || {
        echo "init-env: $name has unexpected characters (stray whitespace or newline?)" >&2
        exit 1
      }
      ;;
    OWNER_GITHUB_USER_ID)
      [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
        echo "init-env: OWNER_GITHUB_USER_ID must be a positive integer with no leading zeros (your numeric GitHub user id, not your login)" >&2
        exit 1
      }
      ;;
    DB_SYNC_ALLOWED_USERS)
      # Drop whitespace, so a list typed as `a, b` is not split into a command when .env.local is
      # sourced. The format check below still applies to what is left.
      value="${value//[[:space:]]/}"
      DB_SYNC_ALLOWED_USERS="$value"
      # The same rule the deploy and the Worker apply. The value goes through the environment, never
      # argv, and its error message gives entry positions, never the entry.
      check_error="$(DB_SYNC_ALLOWED_USERS="$value" node "$script_dir/allowed-users.mjs" check-format 2>&1 >/dev/null)" || {
        echo "$check_error" >&2
        exit 1
      }
      ;;
  esac
done

for name in $generated_names; do
  case "$add_names " in
    *" $name "*)
      key="$(openssl rand -hex 32)" || key=""
      [[ "$key" =~ ^[0-9a-f]{64}$ ]] || {
        echo "init-env: openssl rand failed; nothing was written" >&2
        exit 1
      }
      printf -v "$name" '%s' "$key"
      ;;
  esac
done

umask 077
if [ "$add_missing" = 1 ]; then
  if [ -z "${add_names// /}" ]; then
    echo "init-env: nothing missing; $env_file already has every name"
    exit 0
  else
    # One append, so a failure cannot leave a half-written block. Existing bytes stay as they are.
    block=""
    [ -z "$(tail -c1 "$env_file")" ] || block=$'\n'
    block="$block"$'\n# --- added by scripts/init-env.sh --add-missing ---\n'
    for name in $add_names; do block="$block$name=${!name}"$'\n'; done
    chmod 600 "$env_file"
    printf '%s' "$block" >>"$env_file"
    added="${add_names# }"
    echo "Appended to $env_file (mode 600): ${added// /, }"
  fi
else
  # Fill the template's `NAME=` lines. Values reach awk through its environment, not argv.
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
  echo "The server refuses every user until you list yours in DB_SYNC_ALLOWED_USERS (README section 9)."
fi

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
  pushed=0
  for name in $add_names; do
    # GitHub rejects secret names starting with GITHUB_; .env.local keeps the GITHUB_* names.
    secret_name="$name"
    case "$name" in
      GITHUB_CLIENT_ID | GITHUB_CLIENT_SECRET) secret_name="CONNECTOR_$name" ;;
    esac
    printf '%s' "${!name}" | gh secret set "$secret_name" -R "$target_repo" --env production || {
      echo "init-env: failed to set $secret_name" >&2
      echo "$recovery" >&2
      exit 1
    }
    pushed=$((pushed + 1))
  done
  echo "Pushed $pushed secrets to the GitHub production environment."
fi

echo
echo "Next:"
case "$add_names " in
  *" TOFU_ENCRYPTION_PASSPHRASE "*)
    echo "  - Copy TOFU_ENCRYPTION_PASSPHRASE from .env.local into your password manager — without it the OpenTofu state can't be decrypted."
    ;;
esac
case "$add_names " in
  *" GRAPH_TOKEN_KEY "*)
    echo "  - Copy GRAPH_TOKEN_KEY and COOKIE_ENCRYPTION_KEY from .env.local into your password manager too."
    ;;
esac
# Only when the value written is `none`: a real list needs no next step.
if [[ "$add_names " == *" $allowed_users_name "* && "${DB_SYNC_ALLOWED_USERS:-}" = "none" ]]; then
  echo "  - After your first sign-in, run scripts/list-users.sh, then set DB_SYNC_ALLOWED_USERS to your ID (README section 9)."
fi
if [ "$push" != 1 ]; then
  echo "  - Copy the values to the GitHub production environment (README 1.8)."
fi
