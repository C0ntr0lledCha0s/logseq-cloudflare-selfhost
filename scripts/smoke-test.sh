#!/usr/bin/env bash
# Post-deploy smoke test. Usage: smoke-test.sh <base-url>
# Env: SMOKE_PAT (optional personal access token), PLAN (free|paid, default free).
set -euo pipefail

usage() {
  echo "usage: smoke-test.sh <base-url>   (env: SMOKE_PAT, PLAN=free|paid)" >&2
  exit 2
}

[ "$#" -eq 1 ] && [ -n "$1" ] || usage
base="${1%/}"
plan="${PLAN:-free}"
case "$plan" in
  free | paid) ;;
  *) usage ;;
esac

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

code="$(status "$base/health")"
if [ "$code" != 200 ]; then
  fail health "$code"
elif [ "$(tr -d '[:space:]' <"$body")" != '{"ok":true}' ]; then
  fail health body
else
  pass health
fi

expect_status openapi 200 "$base/openapi.json"
expect_status unauthenticated-graphs 401 "$base/api/v1/graphs"

if [ -n "${SMOKE_PAT:-}" ]; then
  # PATs are assumed to contain no '"' or '\' (curl config quoting).
  # The token is fed to curl on stdin so it never appears in the process list.
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$SMOKE_PAT" |
    status -K - "$base/api/v1/graphs")"
  if [ "$code" = 200 ]; then pass pat-graphs; else fail pat-graphs "$code"; fi
fi

if [ "$plan" = paid ]; then
  expect_status mcp-unauthenticated 401 -X POST -H 'content-type: application/json' -d '{}' "$base/mcp"
fi
