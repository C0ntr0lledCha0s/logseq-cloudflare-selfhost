#!/usr/bin/env bash
# Start the deploy workflow on main and follow it from the terminal.
# Usage: run-deploy.sh [--if-not-green]   (run from anywhere)
#   --if-not-green  do nothing when the latest run of deploy.yml on main already succeeded.
# Prints one line: `deploy: succeeded (<url>)`, `deploy: failed at step "<step>" (<url>)`, or
# `deploy: the run didn't start; ...`. Run logs are never printed. Exit 0 on success, 1 otherwise.
# Env (TEST ONLY): RUN_DEPLOY_POLL_SECONDS sets the seconds between polls for the new run
#   (default 3); honoured only together with RUN_DEPLOY_TEST=1.
set -euo pipefail

usage="usage: run-deploy.sh [--if-not-green]"
if_not_green=0
for arg in "$@"; do
  case "$arg" in
    --if-not-green) if_not_green=1 ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
done

poll_seconds=3
if [ -n "${RUN_DEPLOY_POLL_SECONDS:-}" ]; then
  [ "${RUN_DEPLOY_TEST:-}" = "1" ] || {
    echo "run-deploy: RUN_DEPLOY_POLL_SECONDS is test-only and requires RUN_DEPLOY_TEST=1" >&2
    exit 1
  }
  poll_seconds="$RUN_DEPLOY_POLL_SECONDS"
fi
# 20 polls at the default 3 s is the 60 s the run has to appear. A test's zero interval keeps the 20 polls.
max_polls=20

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
repo="$(cd "$repo_root" && gh repo view --json nameWithOwner -q .nameWithOwner)"
[ -n "$repo" ] || {
  echo "run-deploy: could not determine the GitHub repo for $repo_root" >&2
  exit 1
}

if [ "$if_not_green" = 1 ]; then
  latest="$(gh run list -R "$repo" --workflow deploy.yml --branch main --limit 1 --json conclusion,status)"
  if printf '%s' "$latest" | node -e '
    const runs = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.exit(runs[0]?.status === "completed" && runs[0]?.conclusion === "success" ? 0 : 1);
  '; then
    echo "deploy: the latest run on main succeeded; nothing to do"
    exit 0
  fi
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run deploy.yml -R "$repo" --ref main >/dev/null

# The earliest dispatched run created at or after started_at, as `<id> <url>`; empty when none yet.
find_run() {
  gh run list -R "$repo" --workflow deploy.yml --event workflow_dispatch --limit 5 --json databaseId,createdAt,url |
    STARTED_AT="$started_at" node -e '
      const runs = JSON.parse(require("fs").readFileSync(0, "utf8"))
        .filter((run) => run.createdAt >= process.env.STARTED_AT)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      if (runs[0]) console.log(`${runs[0].databaseId} ${runs[0].url}`);
    '
}

run_ref=""
for ((poll = 1; poll <= max_polls; poll++)); do
  run_ref="$(find_run)"
  [ -z "$run_ref" ] || break
  [ "$poll" -eq "$max_polls" ] || sleep "$poll_seconds"
done
if [ -z "$run_ref" ]; then
  echo "deploy: the run didn't start; check the Actions tab at https://github.com/$repo/actions"
  exit 1
fi
run_id="${run_ref%% *}"
run_url="${run_ref#* }"

# The watch's own output is progress and logs, so only its exit status is used.
if gh run watch "$run_id" -R "$repo" --exit-status >/dev/null; then
  echo "deploy: succeeded ($run_url)"
  exit 0
fi

step="$(gh run view "$run_id" -R "$repo" --json jobs,url | node -e '
  const view = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const steps = view.jobs.flatMap((job) => job.steps ?? []);
  const failed = steps.find((step) => step.conclusion === "failure");
  if (failed) console.log(failed.name);
')" || step=""
if [ -n "$step" ]; then
  echo "deploy: failed at step \"$step\" ($run_url)"
else
  echo "deploy: failed; no failed step was reported ($run_url)"
fi
exit 1
