#!/usr/bin/env bash
# Run a command with R2 S3 credentials derived from the Cloudflare API token.
# Usage: with-r2-credentials.sh <command> [args...]
# Env (required): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
# Env (TEST ONLY): CF_API_BASE overrides https://api.cloudflare.com/client/v4 and
# is honoured only together with WITH_R2_TEST=1; it must be https://, or
# http://127.0.0.1:<port> for local stubs.
#
# R2 accepts credentials derived from an account-owned API token:
#   access key id     = the token id (from the token verify endpoint)
#   secret access key = lowercase hex SHA-256 of the token value
# Exports AWS_* (OpenTofu s3 backend) and R2_* (scripts/backup.sh), then execs
# the command. Used per step so the credentials never reach steps that run
# third-party build code.
set -euo pipefail

[ "$#" -ge 1 ] || {
  echo "usage: with-r2-credentials.sh <command> [args...]" >&2
  exit 2
}
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

# The token is interpolated into a curl config line, so it must be a plain token.
[[ "$CLOUDFLARE_API_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "with-r2-credentials: CLOUDFLARE_API_TOKEN has unexpected characters (stray whitespace or newline?)" >&2
  exit 1
}

api_base="https://api.cloudflare.com/client/v4"
if [ -n "${CF_API_BASE:-}" ]; then
  [ "${WITH_R2_TEST:-}" = "1" ] || {
    echo "with-r2-credentials: CF_API_BASE is test-only and requires WITH_R2_TEST=1" >&2
    exit 1
  }
  [[ "$CF_API_BASE" =~ ^(https://[^[:space:]]+|http://127\.0\.0\.1:[0-9]+)$ ]] || {
    echo "with-r2-credentials: CF_API_BASE must be https:// or http://127.0.0.1:<port>" >&2
    exit 1
  }
  api_base="$CF_API_BASE"
fi

# The token is fed to curl on stdin so it never appears in the process list.
# Tokens are assumed to contain no '"' or '\' (curl config quoting).
response="$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
  curl -sS --max-time 20 -K - "$api_base/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify")" || {
  echo "with-r2-credentials: token verify request failed" >&2
  exit 1
}

token_id="$(printf '%s' "$response" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (body.success !== true || typeof body.result?.id !== "string" || body.result.id === "") process.exit(1);
  process.stdout.write(body.result.id);
')" || {
  echo "with-r2-credentials: token verify did not succeed or returned no token id" >&2
  exit 1
}

secret="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | node -e '
  const token = require("fs").readFileSync(0, "utf8");
  process.stdout.write(require("crypto").createHash("sha256").update(token).digest("hex"));
')"

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::add-mask::$secret"
  echo "::add-mask::$token_id"
fi

export AWS_ACCESS_KEY_ID="$token_id" AWS_SECRET_ACCESS_KEY="$secret"
export R2_ACCESS_KEY_ID="$token_id" R2_SECRET_ACCESS_KEY="$secret"
exec "$@"
