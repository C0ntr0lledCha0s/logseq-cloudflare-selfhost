# Shared by setup.sh and enable-connector.sh, which source it (this file is not run on its own).
# The sourcing script defines `fail` (print the message on stderr and exit 1) and `repo` (the
# owner/name used in the 403 message) before it calls anything here.
#
# Every gh call has stdin closed, so none can prompt or take what the user types for the script's own questions.
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
