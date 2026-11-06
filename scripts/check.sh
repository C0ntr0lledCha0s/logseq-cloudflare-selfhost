#!/usr/bin/env bash
# Usage: check.sh [--upstream]
# The lanes' gate (see docs/lanes/README.md). Runs every check this checkout can run, names each
# check it skipped and why, and exits 1 if any check that ran failed.
#   --upstream  also run upstream db-sync's own suite in .upstream (needed when patches/ changed)
# CHECK_ROOT overrides the repository root (for tests).
set -uo pipefail

root="${CHECK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$root" || exit 1

upstream=0
for arg in "$@"; do
  case "$arg" in
    --upstream) upstream=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

failed=0
results=()

run() {
  local name="$1"
  shift
  echo "== $name"
  if "$@"; then
    results+=("ok       $name")
  else
    results+=("FAILED   $name")
    failed=1
  fi
}

skip() {
  results+=("skipped  $1 ($2)")
}

[ -d node_modules ] || npm ci --silent
run "scripts unit tests" npm test

if [ -f connector/vendor/openapi.json ] && [ -f connector/vendor/semantic_api_tools.mjs ]; then
  [ -d connector/node_modules ] || npm --prefix connector ci --silent
  run "connector tests" npm --prefix connector test
  run "connector typecheck" npm --prefix connector run typecheck
  run "tools manifest" node connector/scripts/check-tools-manifest.mjs
else
  skip "connector tests, typecheck, tools manifest" \
    "connector/vendor missing: scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream"
fi

if [ "$upstream" = 1 ]; then
  if [ -d .upstream/deps/db-sync ]; then
    run "upstream db-sync tests" bash -c 'cd .upstream/deps/db-sync && pnpm test'
  else
    skip "upstream db-sync tests" ".upstream missing: scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream"
  fi
fi

if command -v tofu >/dev/null 2>&1; then
  run "tofu fmt" tofu -chdir=infra fmt -check -recursive
else
  skip "tofu fmt" "tofu not installed"
fi

echo
echo "== summary"
printf '%s\n' "${results[@]}"
exit "$failed"
