#!/usr/bin/env bash
# Usage: bump-pr-body.sh <old-sha> <new-sha> <ci-result> <upstream-dir>
# Prints the markdown body for an upstream bump PR.
# <ci-result> is the GitHub Actions job result of the CI check (success|failure|cancelled|skipped).
set -euo pipefail

old="${1:?usage: bump-pr-body.sh <old-sha> <new-sha> <ci-result> <upstream-dir>}"
new="${2:?usage: bump-pr-body.sh <old-sha> <new-sha> <ci-result> <upstream-dir>}"
ci_result="${3:?usage: bump-pr-body.sh <old-sha> <new-sha> <ci-result> <upstream-dir>}"
upstream_dir="${4:?usage: bump-pr-body.sh <old-sha> <new-sha> <ci-result> <upstream-dir>}"
migrations_path="deps/db-sync/worker/migrations/"

case "$ci_result" in
  success)
    ci_line="CI: ✅ passed"
    ;;
  failure | cancelled | skipped)
    run_url="${GITHUB_SERVER_URL:?}/${GITHUB_REPOSITORY:?}/actions/runs/${GITHUB_RUN_ID:?}"
    ci_line="CI: ❌ failed — see run $run_url"
    ;;
  *)
    echo "unknown ci result: $ci_result" >&2
    exit 2
    ;;
esac

echo "Bump upstream logseq/logseq from \`${old:0:10}\` to \`${new:0:10}\`."
echo
echo "$ci_line"
echo
echo "## Changes in deps/db-sync"
echo
commits="$(git -C "$upstream_dir" log --oneline "$old..$new" -- deps/db-sync)"
if [ -n "$commits" ]; then
  echo '```'
  echo "$commits"
  echo '```'
else
  echo "none"
fi
echo
echo "## New D1 migrations"
echo
added="$(git -C "$upstream_dir" diff --name-only --no-renames --diff-filter=A "$old" "$new" -- "$migrations_path")"
if [ -n "$added" ]; then
  while IFS= read -r file; do
    echo "- \`${file#"$migrations_path"}\`"
  done <<< "$added"
else
  echo "none"
fi
