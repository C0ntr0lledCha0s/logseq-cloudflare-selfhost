#!/usr/bin/env bash
# Usage: upstream-test.sh <checkout> [ns-regex]
#        upstream-test.sh <checkout> --stop
# Runs upstream db-sync's tests in a patched upstream checkout (such as .upstream or a lane's
# scratch copy) against a warm compiler, for quick iteration on patches. The gate is still
# scripts/check.sh --upstream, which compiles from cold and runs every test.
#
# The first call starts `clojure -M:cljs watch db-sync-test` in the background for that checkout
# (pidfile and log in <checkout>/deps/db-sync/tmp/lane-watch/), and later calls reuse it. Each call
# waits until the watch has finished a build that started after the latest source change, exits 1
# with the compiler's error on a build failure, and otherwise runs
# `node worker/dist/worker-test.js [ns-regex]` and exits with its code. With ns-regex, only the
# namespaces whose name contains a match run (patch 0021), e.g. `semantic-choice-values`.
# --stop kills the checkout's watch. If the watch can't start, it falls back to a one-shot compile.
#
# Callers on one checkout are serialised with flock. Overrides (for tests):
#   UPSTREAM_TEST_WATCH_CMD, UPSTREAM_TEST_COMPILE_CMD, UPSTREAM_TEST_RUN_CMD (run in deps/db-sync),
#   UPSTREAM_TEST_TIMEOUT (seconds to wait for the lock and for a build; default 600).
set -uo pipefail

usage() {
  echo "usage: upstream-test.sh <checkout> [ns-regex] | upstream-test.sh <checkout> --stop" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
checkout="$1"
arg="${2:-}"
case "$arg" in
  --stop | "") ;;
  -*) usage ;;
esac

if [ ! -d "$checkout/deps/db-sync" ]; then
  echo "not a patched upstream checkout: $checkout/deps/db-sync is missing" >&2
  exit 2
fi
checkout="$(cd "$checkout" && pwd)"
dir="$checkout/deps/db-sync"
state="$dir/tmp/lane-watch"
pidfile="$state/watch.pid"
log="$state/watch.log"
watch_cmd="${UPSTREAM_TEST_WATCH_CMD:-clojure -M:cljs watch db-sync-test}"
compile_cmd="${UPSTREAM_TEST_COMPILE_CMD:-clojure -M:cljs compile db-sync-test}"
run_cmd="${UPSTREAM_TEST_RUN_CMD:-node worker/dist/worker-test.js}"
timeout="${UPSTREAM_TEST_TIMEOUT:-600}"
mkdir -p "$state"

# One caller per checkout at a time. The lock is on fd 9, which the watch must not inherit.
exec 9>"$state/lock"
if ! flock -w "$timeout" 9; then
  echo "timed out after ${timeout}s waiting for another upstream-test.sh on $checkout" >&2
  exit 1
fi

watch_pid() {
  local pid
  pid="$(cat "$pidfile" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

stop_watch() {
  local pid i
  if pid="$(watch_pid)"; then
    # The watch runs in its own session, so its pid is also its process group.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    for i in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$pid" 2>/dev/null
    rm -f "$pidfile"
    echo "stopped the watch for $checkout (pid $pid)"
  else
    rm -f "$pidfile"
    echo "no watch running for $checkout"
  fi
}

if [ "$arg" = "--stop" ]; then
  stop_watch
  exit 0
fi
ns="$arg"

# The newest modification time among the sources the watch compiles: db-sync's own src and test,
# and the local deps on its classpath (deps.edn).
latest_change() {
  local dirs=() d
  for d in "$dir/src" "$dir/test" "$checkout"/deps/{common,db,outliner,graph-parser}/src; do
    [ -d "$d" ] && dirs+=("$d")
  done
  [ ${#dirs[@]} -gt 0 ] || { echo 0; return; }
  find "${dirs[@]}" -type f \( -name '*.cljs' -o -name '*.cljc' -o -name '*.clj' \) -printf '%T@\n' 2>/dev/null |
    sort -n | tail -1 | grep . || echo 0
}

# The latest build in the log that started at or after time $1, as "<status> <line>", where status
# is "completed" or "failure" and line is where that build started. Log lines are timestamped.
build_after() {
  awk -v t="$1" '
    / Compiling \.\.\./ { start = NR; started = $1 + 0; next }
    / Build completed\./ { if (start && started >= t) { found = "completed " start } }
    / Build failure/ { if (start && started >= t) { found = "failure " start } }
    END { if (found) print found }
  ' "$log" 2>/dev/null
}

start_watch() {
  rm -f "$pidfile"
  : >"$log"
  if ! command -v setsid >/dev/null 2>&1; then
    echo "setsid is not installed" >>"$log"
    return 1
  fi
  (
    cd "$dir" || exit 1
    UT_PIDFILE="$pidfile" UT_WATCH_CMD="$watch_cmd" exec setsid bash -c '
      echo $$ > "$UT_PIDFILE"
      eval "$UT_WATCH_CMD" 2>&1 | while IFS= read -r line; do printf "%s %s\n" "$EPOCHREALTIME" "$line"; done
    '
  ) >>"$log" 2>&1 </dev/null 9>&- &
  local i
  for i in $(seq 1 50); do
    [ -s "$pidfile" ] && return 0
    sleep 0.1
  done
  return 1
}

one_shot() {
  echo "upstream-test: falling back to a one-shot compile: $1"
  if [ -s "$log" ]; then
    echo "--- watch log (last 20 lines)"
    tail -n 20 "$log" | cut -d' ' -f2-
    echo "---"
  fi
  rm -f "$pidfile"
  (cd "$dir" && eval "$compile_cmd") || { echo "upstream-test: the one-shot compile failed" >&2; exit 1; }
}

began=$SECONDS
compiled=0
if watch_pid >/dev/null; then
  echo "upstream-test: reusing the watch for $checkout"
elif start_watch; then
  echo "upstream-test: starting a watch for $checkout (log: $log)"
else
  one_shot "the watch did not start"
  compiled=1
fi

if [ "$compiled" = 0 ]; then
  since="$(latest_change)"
  result=""
  while :; do
    result="$(build_after "$since")"
    [ -n "$result" ] && break
    if ! watch_pid >/dev/null; then
      sleep 0.2
      result="$(build_after "$since")"
      [ -n "$result" ] && break
      one_shot "the watch exited before finishing a build"
      compiled=1
      break
    fi
    if [ $((SECONDS - began)) -ge "$timeout" ]; then
      echo "upstream-test: timed out after ${timeout}s waiting for the watch to finish a build that started after the latest source change (log: $log)" >&2
      exit 1
    fi
    sleep 0.2
  done
  if [ "$compiled" = 0 ]; then
    status="${result%% *}"
    start="${result#* }"
    if [ "$status" = failure ]; then
      echo "upstream-test: Build failure (log: $log)" >&2
      tail -n +"$start" "$log" | head -n 60 | cut -d' ' -f2- >&2
      exit 1
    fi
    echo "upstream-test: build ready after $((SECONDS - began))s"
  fi
fi

out="$state/run.out"
(cd "$dir" && eval "$run_cmd" '${ns:+"$ns"}') 2>&1 | tee "$out"
code=${PIPESTATUS[0]}
if [ "$code" = 0 ] && [ -n "$ns" ] && grep -q '^Ran 0 tests' "$out"; then
  echo "upstream-test: no test namespace matches \"$ns\"" >&2
  exit 1
fi
exit "$code"
