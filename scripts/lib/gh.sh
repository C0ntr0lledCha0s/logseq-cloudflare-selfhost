# Shared gh helpers, sourced (this file is not run on its own). setup.sh, enable-connector.sh,
# init-env.sh and run-deploy.sh use origin_repo. Only setup.sh and enable-connector.sh use gh_try and
# gh_must; they define `fail` (print the message on stderr and exit 1) and `repo` (the owner/name
# used in the 403 message) before they call either.
#
# Every gh call has stdin closed, so none can prompt or take what the user types for the script's own questions.

# origin_repo ROOT prints the owner/name of the GitHub repo that ROOT's `origin` remote points at, and
# returns 1 when there is no origin or gh can't read it. `gh repo view` with no repo argument ranks the
# remotes upstream > github > origin, so in a fork clone with an `upstream` remote it names the parent
# repo. Every script resolves the repo here instead, and passes it to gh with -R or in the API path.
origin_repo() {
  local url name
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  name="$(gh repo view "$url" --json nameWithOwner -q .nameWithOwner </dev/null)" || return 1
  [ -n "$name" ] || return 1
  printf '%s\n' "$name"
}

# gh_try runs a gh command, keeping its output in gh_out and its error in gh_err. It returns 0 on
# success and 4 for a 404 (the caller decides whether that means "missing"). A 403 stops with the admin
# message, and any other failure stops with gh's own message.
gh_out=""
gh_err=""
gh_try() {
  local errfile
  errfile="$(mktemp)"
  if gh_out="$("$@" 2>"$errfile" </dev/null)"; then
    rm -f "$errfile"
    return 0
  fi
  gh_err="$(cat "$errfile")"
  rm -f "$errfile"
  case "$gh_err" in
    *"HTTP 404"*) return 4 ;;
    *"HTTP 403"*)
      local login
      login="$(gh api user -q .login 2>/dev/null </dev/null || true)"
      fail "gh is logged in as ${login:-unknown} (gh api user -q .login), which can't change settings on $repo: it needs admin on the repo."
      ;;
    *) fail "$gh_err" ;;
  esac
}
# Like gh_try, but a 404 stops too.
gh_must() {
  local rc=0
  gh_try "$@" || rc=$?
  [ "$rc" -eq 0 ] || fail "$gh_err"
}
