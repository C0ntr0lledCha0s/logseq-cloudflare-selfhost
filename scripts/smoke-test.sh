#!/usr/bin/env bash
# Post-deploy smoke test. Usage: smoke-test.sh <base-url>
# Env: SMOKE_PAT (optional personal access token).
# A fresh deploy's certificate takes minutes to issue, so the first /health request
# is retried: 10 attempts, 15 seconds apart. SMOKE_HEALTH_ATTEMPTS and
# SMOKE_HEALTH_DELAY override that, and only when SMOKE_TEST=1 (the tests use 0 delay).
set -euo pipefail

usage() {
  echo "usage: smoke-test.sh <base-url>   (env: SMOKE_PAT)" >&2
  exit 2
}

[ "$#" -eq 1 ] && [ -n "$1" ] || usage
base="${1%/}"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# status <curl args...>: prints the HTTP status, or 000 on a transport error.
# The response body is left in "$body".
status() {
  local code
  : >"$body"
  code="$(curl -sS --max-time 20 -o "$body" -w '%{http_code}' "$@" 2>/dev/null)" || code=000
  echo "$code"
}

pass() { echo "ok $1"; }
fail() {
  echo "FAIL $1: $2"
  exit 1
}

expect_status() { # name expected curl-args...
  local name="$1" expected="$2" code
  shift 2
  code="$(status "$@")"
  if [ "$code" = "$expected" ]; then pass "$name"; else fail "$name" "$code"; fi
}

health_attempts=10
health_delay=15
if [ "${SMOKE_TEST:-}" = 1 ]; then
  health_attempts="${SMOKE_HEALTH_ATTEMPTS:-10}"
  health_delay="${SMOKE_HEALTH_DELAY:-15}"
  [[ "$health_attempts" =~ ^[1-9][0-9]*$ ]] || { echo "SMOKE_HEALTH_ATTEMPTS must be a positive integer" >&2; exit 2; }
  [[ "$health_delay" =~ ^[0-9]+$ ]] || { echo "SMOKE_HEALTH_DELAY must be a whole number of seconds" >&2; exit 2; }
fi

attempt=1
while :; do
  code="$(status "$base/health")"
  [ "$code" != 200 ] && [ "$attempt" -lt "$health_attempts" ] || break
  echo "health: $code (attempt $attempt of $health_attempts), retrying in ${health_delay}s" >&2
  sleep "$health_delay"
  attempt=$((attempt + 1))
done
if [ "$code" != 200 ]; then
  fail health "$code"
elif [ "$(tr -d '[:space:]' <"$body")" != '{"ok":true}' ]; then
  fail health body
else
  pass health
fi

expect_status openapi 200 "$base/openapi.json"
expect_status unauthenticated-graphs 401 "$base/api/v1/graphs"

# A token that isn't a JWT must be refused. Keep it to this exact shape: a three-part
# garbage token makes upstream's JWT decoder throw a 500, which is outside this check.
expect_status jwt-garbage-refused 401 -H 'Authorization: Bearer not-a-jwt' "$base/api/v1/graphs"

if [ -n "${SMOKE_PAT:-}" ]; then
  # PATs are assumed to contain no '"' or '\' (curl config quoting).
  # The token is fed to curl on stdin so it never appears in the process list.
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$SMOKE_PAT" |
    status -K - "$base/api/v1/graphs")"
  if [ "$code" = 200 ]; then pass pat-graphs; else fail pat-graphs "$code"; fi
else
  echo "note: SMOKE_PAT is not set, so the allow-list was not checked end to end"
fi

# Upstream's /mcp answered anyone without a token; patch 0020 removes it, so the
# path falls through to the sync worker's not-found response.
expect_status upstream-mcp-off 404 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$base/mcp"
