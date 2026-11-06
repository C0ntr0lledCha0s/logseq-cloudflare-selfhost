#!/usr/bin/env bash
# SessionStart hook: prepare a fresh Claude Code container so a lane can run scripts/check.sh
# straight away. It installs Node dependencies and reports what the connector checks need.
# Never exits non-zero, because a failed bootstrap must not stop the session from starting.
set -u
log() { printf '[session-start] %s\n' "$*"; }
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

if [ ! -d node_modules ]; then
  log "installing root dependencies…"
  npm ci --silent || log "npm ci failed (continuing)"
fi

if [ -f connector/vendor/openapi.json ] && [ -f connector/vendor/semantic_api_tools.mjs ]; then
  if [ ! -d connector/node_modules ]; then
    log "installing connector dependencies…"
    npm --prefix connector ci --silent || log "connector npm ci failed (continuing)"
  fi
  log "connector/vendor present: scripts/check.sh runs the connector suite"
else
  log "connector/vendor missing: scripts/check.sh will skip the connector suite."
  log "  to build it (several minutes, needs mise's toolchain):"
  log "  scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream"
fi

[ -f .claude/lanes.local.json ] || log "no .claude/lanes.local.json: /lane will look up the issues graph with list_graphs"
log "ready"
exit 0
