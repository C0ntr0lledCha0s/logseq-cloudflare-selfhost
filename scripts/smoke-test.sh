#!/usr/bin/env bash
# Post-deploy smoke test. Usage: smoke-test.sh <base-url>
# Env: SMOKE_PAT (optional personal access token).
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

# A token that isn't a JWT must be refused. Keep it to this exact shape: a three-part
# garbage token makes upstream's JWT decoder throw a 500, which is outside this check.
expect_status jwt-garbage-refused 401 -H 'Authorization: Bearer not-a-jwt' "$base/api/v1/graphs"

if [ -n "${SMOKE_PAT:-}" ]; then
  # PATs are assumed to contain no '"' or '\' (curl config quoting).
  # The token is fed to curl on stdin so it never appears in the process list.
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$SMOKE_PAT" |
    status -K - "$base/api/v1/graphs")"
  if [ "$code" = 200 ]; then pass pat-graphs; else fail pat-graphs "$code"; fi

  # datalog_query against the deployed bundle: a value bound by a data pattern must come back.
  # Without Datascript's externs the release build renamed the Datom field v and every such value
  # came back null (patch 0040). Tries each ready, non-E2EE graph the list shows until one is not
  # 403 (a PAT can be scoped to one graph).
  graphs="$(node -e '
    const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const g of body.graphs ?? []) {
      if (!g["graph-e2ee?"] && g["graph-ready-for-use?"] !== false) console.log(g["graph-id"]);
    }' "$body" 2>/dev/null)" || graphs=""
  query='{"query":"[:find ?id :where [?e :db/ident :logseq.class/Tag] [?e :db/ident ?id]]"}'
  queried=0
  for graph in $graphs; do
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$SMOKE_PAT" |
      status -K - -X POST -H 'content-type: application/json' -d "$query" "$base/api/v1/graphs/$graph/query")"
    [ "$code" = 403 ] && continue
    [ "$code" = 200 ] || fail datalog-query "$code"
    if node -e '
      const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(JSON.stringify(body.rows) === JSON.stringify([["logseq.class/Tag"]]) ? 0 : 1);' "$body" 2>/dev/null; then
      pass datalog-query
    else
      fail datalog-query "rows $(head -c 200 "$body")"
    fi
    queried=1
    break
  done
  [ "$queried" = 1 ] || echo "note: no graph this PAT can read, so datalog-query was not checked"
else
  echo "note: SMOKE_PAT is not set, so the allow-list was not checked end to end"
fi

# Upstream's /mcp answered anyone without a token; patch 0020 removes it, so the
# path falls through to the sync worker's not-found response.
expect_status upstream-mcp-off 404 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$base/mcp"
