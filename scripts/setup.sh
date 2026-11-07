#!/usr/bin/env bash
# One command from a fresh fork to a deployed server whose owner is being claimed.
# Usage: setup.sh [--yes] [--repush] [--deploy]   (run from inside your clone; needs gh, node 22+, openssl, git)
#   --yes      don't ask: skip the repo question and the wait for you to save the passphrase
#   --repush   push all seven secrets again, not just the missing ones (after editing .env.local), and deploy
#   --deploy   run the deploy even when the latest one succeeded (it always runs after stage 6 pushed anything)
# Eight stages, in order. Each checks whether its work is already done and says `done` if so, so
# re-running continues from the stage that failed, and a finished install is left as it is:
#   1 prerequisites  2 which repo  3 values (.env.local)  4 checks (doctor)  5 GitHub settings
#   6 secrets  7 first deploy  8 next steps (claim the owner)
# Secrets never appear in arguments or output: init-env.sh reads them and pushes them on stdin.
# Env (TEST ONLY, with SETUP_TEST=1): SETUP_REPO_ROOT, the root that holds .env.local and the scripts it calls.
set -euo pipefail

usage="usage: setup.sh [--yes] [--repush] [--deploy]"
yes=0
repush=0
deploy=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --repush) repush=1 ;;
    --deploy) deploy=1 ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${SETUP_REPO_ROOT:-}" ]; then
  [ "${SETUP_TEST:-}" = "1" ] || {
    echo "setup: SETUP_REPO_ROOT is test-only and requires SETUP_TEST=1" >&2
    exit 1
  }
  repo_root="$SETUP_REPO_ROOT"
fi
scripts="$repo_root/scripts"
env_file="$repo_root/.env.local"
cd "$repo_root"

required_secrets="CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN DB_SYNC_ALLOWED_USERS SYNC_HOSTNAME"

stage() { printf '\n== %s. %s\n' "$1" "$2"; }
fail() {
  echo "$*" >&2
  exit 1
}

# origin_repo, gh_try and gh_must (stdin closed on every gh call, 404 and 403 told apart) live in lib/gh.sh.
# shellcheck source=lib/gh.sh
. "$scripts/lib/gh.sh"

# The names in a `--json name` list, one per line.
json_names() { node -e 'for (const x of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(x.name)'; }
# `<file name> <state>` per workflow from `--json path,state`.
json_workflows() { node -e 'for (const x of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(x.path.split("/").pop(), x.state)'; }
# Whether the word $1 is on a line of its own in $2.
has_line() { printf '%s\n' "$2" | grep -Fxq -- "$1"; }

# ---- 1. Prerequisites ----
stage 1 "Prerequisites"
repo=""
gh_missing="install gh (https://cli.github.com) and run gh auth login"
command -v gh >/dev/null 2>&1 || fail "$gh_missing"
auth_status="$(gh auth status 2>&1 </dev/null)" || fail "$gh_missing"
# Fine-grained tokens print no scopes line, so they're left to the 403 handling in stage 5.
scopes_line="$(printf '%s\n' "$auth_status" | grep -i 'token scopes' || true)"
if [ -n "$scopes_line" ] && ! printf '%s\n' "$scopes_line" | grep -Eq "(^|[ ,'\"])repo([ ,'\"]|$)"; then
  fail "gh needs the repo scope: run gh auth refresh -s repo"
fi
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null || fail "Node 22 or newer is required: install it, then re-run scripts/setup.sh"
command -v openssl >/dev/null 2>&1 || fail "openssl is required and isn't on PATH"
origin_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  *github.com*) ;;
  *) fail "the git remote origin must be a github.com URL (git remote get-url origin): clone your fork of this repo and run this from it" ;;
esac
echo "done"

# ---- 2. Which repo ----
stage 2 "Which repo"
# The repo the origin remote points at (lib/gh.sh), never gh's own pick, which is the parent in a fork clone with an upstream remote.
repo="$(origin_repo "$repo_root")" || fail "couldn't read the origin remote's repo from gh: run gh auth status"
is_fork="$(gh repo view "$repo" --json isFork -q .isFork </dev/null)" || fail "couldn't read $repo from gh: run gh auth status"
echo "This will set up $repo (GitHub) and deploy to your Cloudflare account."
if [ "$is_fork" = "false" ]; then
  echo "Note: $repo is not a fork. If you meant to set up your own copy, fork it first (README \"Before you start\")."
fi
if [ "$yes" = 0 ]; then
  printf 'Set up %s? [y/N] ' "$repo"
  answer=""
  read -r answer || answer=""
  case "$answer" in
    y | Y | yes | YES | Yes) ;;
    *) fail "nothing changed" ;;
  esac
fi

# ---- 3. Values ----
stage 3 "Values"
if [ ! -f "$env_file" ]; then
  rc=0
  gh_try gh secret list -R "$repo" --env production --json name || rc=$?
  # A missing environment (404) holds no secrets.
  existing=""
  [ "$rc" -ne 0 ] || existing="$(printf '%s' "$gh_out" | json_names)"
  if [ -n "$existing" ]; then
    fail "This repo is already set up: its production environment holds secrets, but there is no .env.local here. Restore .env.local from your password manager (or copy it from your other machine), then re-run. Generating new values would leave you with a TOFU_ENCRYPTION_PASSPHRASE that can't decrypt the state."
  fi
  echo "Create the Cloudflare API token with this link, then paste it below:"
  node "$scripts/token-link.mjs"
  # Stage 6 pushes the values, so init-env.sh leaves out its "copy them to GitHub" step.
  INIT_ENV_CALLER=setup "$scripts/init-env.sh"
  [ -f "$env_file" ] || fail "init-env.sh didn't write .env.local: fix what it reported, then re-run scripts/setup.sh"
else
  echo "done"
fi
allowed_users="$(node "$scripts/env-file.mjs" get DB_SYNC_ALLOWED_USERS --file "$env_file")"
sync_hostname="$(node "$scripts/env-file.mjs" get SYNC_HOSTNAME --file "$env_file")"
if [ "$yes" = 0 ]; then
  printf 'Save TOFU_ENCRYPTION_PASSPHRASE from .env.local in your password manager now. Press Enter when done.\n'
  read -r _ || true
fi

# ---- 4. Checks ----
stage 4 "Checks"
# The environment, secrets and schedules can't pass before stages 5 and 6, so doctor skips them.
if ! DOCTOR_SKIP_GITHUB=1 "$scripts/doctor.sh"; then
  fail "fix the FAIL lines above, then re-run scripts/setup.sh"
fi

# ---- 5. GitHub settings ----
stage 5 "GitHub settings"

rc=0
gh_try gh api "repos/$repo/environments/production" || rc=$?
restricted=0
if [ "$rc" -eq 0 ]; then
  printf '%s' "$gh_out" | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0, "utf8")).deployment_branch_policy?.custom_branch_policies === true ? 0 : 1)' && restricted=1
fi
if [ "$restricted" = 0 ]; then
  # Missing, or present but open to every branch, which would let any branch read its secrets.
  gh_must gh api -X PUT "repos/$repo/environments/production" \
    -F 'deployment_branch_policy[protected_branches]=false' \
    -F 'deployment_branch_policy[custom_branch_policies]=true'
fi
# Restricted to named branches but with no `main` policy (an earlier run whose POST failed), every
# deploy of main is refused, so the policy is checked on its own.
gh_must gh api "repos/$repo/environments/production/deployment-branch-policies?per_page=100"
has_main=0
printf '%s' "$gh_out" | node -e '
  const { branch_policies } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.exit(branch_policies.some((p) => p.name === "main" && p.type === "branch") ? 0 : 1);
' && has_main=1
if [ "$has_main" = 0 ]; then
  # GitHub answers 303 when the same policy already exists, so a repeated POST is harmless.
  rc=0
  gh_try gh api -X POST "repos/$repo/environments/production/deployment-branch-policies" -f name=main -f type=branch || rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || fail "$gh_err"
fi
if [ "$restricted" = 0 ]; then
  echo "environment: created production, restricted to main"
elif [ "$has_main" = 0 ]; then
  echo "environment: added the main branch policy"
else
  echo "environment: done"
fi

gh_must gh api "repos/$repo/rulesets" --jq '.[].name'
if has_line "Protect main" "$gh_out"; then
  echo "ruleset: done"
else
  gh_must gh api -X POST "repos/$repo/rulesets" --input .github/rulesets/protect-main.json
  echo "ruleset: created Protect main"
fi

gh_must gh api "repos/$repo/actions/permissions/workflow" -q .can_approve_pull_request_reviews
if [ "$gh_out" = "true" ]; then
  echo "workflow permission: done"
else
  gh_must gh api -X PUT "repos/$repo/actions/permissions/workflow" \
    -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
  echo "workflow permission: allowed Actions to create pull requests"
fi

gh_must gh api "repos/$repo/actions/permissions" -q .enabled
if [ "$gh_out" = "true" ]; then
  echo "actions: done"
else
  echo "Enable Actions: open https://github.com/$repo/actions and click the green button. Press Enter when done."
  read -r _ || true
  gh_must gh api "repos/$repo/actions/permissions" -q .enabled
  [ "$gh_out" = "true" ] || fail "GitHub Actions is still disabled on $repo: enable it, then re-run scripts/setup.sh"
  echo "actions: enabled"
fi

# GitHub disables scheduled workflows on a new public fork, so they're enabled here.
if [ "$is_fork" = "true" ]; then upstream_workflow="sync-upstream.yml"; else upstream_workflow="bump-upstream.yml"; fi
gh_must gh workflow list -R "$repo" --all --json path,state
workflow_states="$(printf '%s' "$gh_out" | json_workflows)"
for file in backup.yml usage.yml "$upstream_workflow"; do
  state="$(printf '%s\n' "$workflow_states" | awk -v f="$file" '$1 == f { print $2 }')"
  if [ -z "$state" ]; then
    echo "$file: not in this repo yet, skipped"
  elif [ "$state" = "active" ]; then
    echo "$file: done"
  else
    gh_must gh workflow enable "$file" -R "$repo"
    echo "$file: enabled (was $state)"
  fi
done

# ---- 6. Secrets ----
stage 6 "Secrets"
gh_must gh secret list -R "$repo" --env production --json name
present="$(printf '%s' "$gh_out" | json_names)"
missing=()
for name in $required_secrets; do
  if [ "$repush" = 1 ] || ! has_line "$name" "$present"; then missing+=("$name"); fi
done
pushed=0
if [ "${#missing[@]}" -eq 0 ]; then
  echo "done"
else
  echo "pushing ${missing[*]}"
  "$scripts/init-env.sh" --push-only "${missing[@]}"
  pushed=1
fi

# ---- 7. First deploy ----
stage 7 "First deploy"
# A pushed secret reaches the Workers only with a new deploy, so a green last run doesn't count then.
if [ "$deploy" = 1 ] || [ "$pushed" = 1 ]; then deploy_args=(); else deploy_args=(--if-not-green); fi
"$scripts/run-deploy.sh" ${deploy_args[@]+"${deploy_args[@]}"} || fail "the deploy didn't succeed: fix what it reported, then re-run scripts/setup.sh"

# ---- 8. Next steps ----
stage 8 "Next steps"
if [ "$allowed_users" = "none" ]; then
  echo "Your server is at https://$sync_hostname."
  exec "$scripts/allow-user.sh" --owner
fi
echo "Setup is complete. Run scripts/doctor.sh any time to check it."
