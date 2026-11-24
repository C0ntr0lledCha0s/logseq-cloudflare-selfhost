#!/usr/bin/env bash
# Usage: bump-branch.sh <branch> <new-sha> <base-branch> <note-file>
# Points UPSTREAM_REF on the upstream bump branch at <new-sha> and pushes the branch to origin.
# Run it from a full-history checkout of <base-branch> (the bump workflow's `pr` job).
#
# - No branch on origin yet, or only github-actions[bot] commits on it (author and committer) on top
#   of <base-branch>: the branch is rebuilt from <base-branch> with one bot commit and force-pushed
#   (mode=force). Nothing anyone else made is lost.
# - Any other commit on it (usually a patch refresh pushed by a person or agent): the branch is kept.
#   <base-branch> is merged in if it has moved on (never a rebase), UPSTREAM_REF is set in a new bot
#   commit, and the branch is pushed without force (mode=merge). If the merge conflicts or the push
#   is refused, nothing is pushed (mode=skip).
#
# Writes mode=<force|merge|skip> and branch=<branch> to $GITHUB_OUTPUT. For merge and skip it writes
# a note for the PR comment and the step summary to <note-file>; for force the file is left empty.
set -euo pipefail

usage="usage: bump-branch.sh <branch> <new-sha> <base-branch> <note-file>"
branch="${1:?$usage}"
new="${2:?$usage}"
base="${3:?$usage}"
note="${4:?$usage}"
short="${new:0:10}"
bot_name="github-actions[bot]"
bot_email="41898283+github-actions[bot]@users.noreply.github.com"

as_bot() { git -c user.name="$bot_name" -c user.email="$bot_email" "$@"; }

set_upstream_ref() {
  printf '%s\n' "$new" > UPSTREAM_REF
  git add UPSTREAM_REF
  if ! git diff --cached --quiet -- UPSTREAM_REF; then
    as_bot commit -q -m "chore: bump upstream to $short"
  fi
}

finish() {
  echo "mode=$1" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "branch=$branch" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "bump-branch: mode=$1 branch=$branch" >&2
  exit 0
}

: > "$note"
git fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base"

hand_made=""
if git ls-remote --exit-code --heads origin "$branch" > /dev/null; then
  git fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  hand_made="$(git log --format='%ae%x09%ce%x09- %h %s (%an)' "origin/$base..origin/$branch" \
    | awk -F '\t' -v bot="$bot_email" '!($1 == bot && $2 == bot) { print $3 }')"
fi

if [ -z "$hand_made" ]; then
  # Only the bot's own commits (or none): rebuild from the base branch, as the workflow always did.
  as_bot checkout -q -B "$branch" "origin/$base"
  set_upstream_ref
  git push -q --force origin "HEAD:refs/heads/$branch"
  finish force
fi

intro="The bump branch \`$branch\` has commits not made by github-actions[bot], so this run did not force-push it:

$hand_made
"
refresh="The patches may need refreshing for the new upstream commit \`$short\`. Check CI on the branch."

as_bot checkout -q -B "$branch" "origin/$branch"
merged=""
if ! git merge-base --is-ancestor "origin/$base" HEAD; then
  if as_bot merge -q --no-ff --no-edit -m "Merge $base into $branch" "origin/$base" > /dev/null 2>&1; then
    merged="It merged \`$base\` into the branch first. "
  else
    git merge --abort
    printf '%s\n%s\n' "$intro" "The branch was **not updated**: merging \`$base\` into it gives a conflict, so it still pins its earlier upstream commit while upstream is at \`$short\`. Merge \`$base\` and set \`UPSTREAM_REF\` by hand. $refresh" > "$note"
    finish skip
  fi
fi

set_upstream_ref
if ! git push -q origin "HEAD:refs/heads/$branch"; then
  printf '%s\n%s\n' "$intro" "The branch was **not updated**: the push was refused (someone may have pushed while this ran, or the merge brings in workflow changes the default token may not push). Upstream is at \`$short\`; run the workflow again. $refresh" > "$note"
  finish skip
fi
printf '%s\n%s\n' "$intro" "${merged}It kept those commits and set \`UPSTREAM_REF\` to \`$short\` in a new commit on top. $refresh" > "$note"
finish merge
