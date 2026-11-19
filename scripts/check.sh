#!/usr/bin/env bash
# Usage: check.sh [--upstream]
# The lanes' gate (see docs/lanes/README.md). Runs every check this checkout can run, names each
# check it skipped and why, warns naming each scripts test that skipped itself, and exits 1 if
# any check that ran failed.
#   --upstream  also run upstream db-sync's own suite in .upstream (needed when patches/ changed),
#               then query its release bundle (scripts/release-query-check.mjs) when it is built
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
# The scripts' tests print TAP here (stdout is a pipe), so a test that skipped itself, for
# example because the last build removed what it needs, can be named in the summary.
tests_log="$(mktemp)"
trap 'rm -f "$tests_log"' EXIT
run "scripts unit tests" bash -c 'npm test 2>&1 | tee "$1"; exit "${PIPESTATUS[0]}"' _ "$tests_log"
skipped_tests=()
while IFS= read -r line; do
  skipped_tests+=("$line")
done < <(sed -nE 's/^[[:space:]]*ok [0-9]+ - (.*) # SKIP[[:space:]]*(.*)$/\1\t\2/p' "$tests_log")

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
    # Queries the release bundle deploy ships (its Datascript seeds from the test build just
    # compiled). It tests the bundle as last built: rebuild with scripts/build.sh after a patch change.
    if [ -f .upstream/deps/db-sync/worker/dist/worker/main.js ]; then
      run "release bundle query check" node scripts/release-query-check.mjs .upstream
    else
      skip "release bundle query check" "release bundle missing: scripts/build.sh .upstream"
    fi
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
# A skipped test proves nothing, so the gate names each one. It warns rather than fails: a
# checkout without a build can still run the rest.
if [ "${#skipped_tests[@]}" -gt 0 ]; then
  echo "WARNING  scripts unit tests skipped ${#skipped_tests[@]} test(s); a skipped test proves nothing:"
  for entry in "${skipped_tests[@]}"; do
    name="${entry%%$'\t'*}"
    reason="${entry#*$'\t'}"
    if [ -n "$reason" ]; then echo "  - $name ($reason)"; else echo "  - $name"; fi
  done
fi
exit "$failed"
