#!/usr/bin/env bash
# Post-deploy smoke test for the connector Worker. Usage: smoke-connector.sh <base-url>
# Env: SMOKE_RETRY_DELAY seconds between attempts at the first request (default 3).
set -euo pipefail

usage() {
  echo "usage: smoke-connector.sh <base-url>" >&2
  exit 2
}

[ "$#" -eq 1 ] && [ -n "$1" ] || usage
base="${1%/}"

body="$(mktemp)"
headers="$(mktemp)"
trap 'rm -f "$body" "$headers"' EXIT

# status <curl args...>: prints the HTTP status, or 000 on a transport error.
# The response body is left in "$body" and the response headers in "$headers".
status() {
  local code
  : >"$body"
  : >"$headers"
  code="$(curl -sS --max-time 20 -o "$body" -D "$headers" -w '%{http_code}' "$@" 2>/dev/null)" || code=000
  echo "$code"
}

# header <name>: prints the value of a response header (case-insensitive), CR stripped.
header() {
  grep -i "^$1:" "$headers" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^[[:space:]]*//' || true
}

pass() { echo "ok $1"; }
fail() {
  echo "FAIL $1: $2"
  exit 1
}

# The path @cloudflare/workers-oauth-provider serves for the /mcp resource (see connector/test/auth.test.ts).
# A fresh deploy can take a few seconds to answer on its custom domain, so the first request
# is attempted up to 5 times; every later check runs against a Worker that has already answered.
for attempt in 1 2 3 4 5; do
  code="$(status "$base/.well-known/oauth-protected-resource/mcp")"
  [ "$code" = 200 ] && break
  [ "$attempt" -lt 5 ] && sleep "${SMOKE_RETRY_DELAY:-3}"
done
if [ "$code" != 200 ]; then
  fail oauth-metadata "$code"
fi
resource="$(node -e '
  try {
    const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (typeof body.resource === "string") process.stdout.write(body.resource);
  } catch {}
' "$body")"
if [ "$resource" != "$base/mcp" ]; then
  fail oauth-metadata resource
fi
pass oauth-metadata

code="$(status -X POST -H 'content-type: application/json' -d '{}' "$base/mcp")"
if [ "$code" != 401 ]; then
  fail mcp-unauthenticated "$code"
elif [ -z "$(header www-authenticate)" ]; then
  fail mcp-unauthenticated "no WWW-Authenticate"
fi
pass mcp-unauthenticated

code="$(status "$base/graphs")"
if [ "$code" != 302 ]; then
  fail wizard-requires-login "$code"
fi
case "$(header location)" in
  /login | "$base/login") pass wizard-requires-login ;;
  *) fail wizard-requires-login location ;;
esac
