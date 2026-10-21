#!/usr/bin/env bash
# Usage: build.sh <upstream-dir>
# Builds the db-sync worker bundle and API docs inside a patched upstream checkout.
set -euo pipefail

upstream="${1:?usage: build.sh <upstream-dir>}"
cd "$upstream/deps/db-sync"

# --ignore-workspace: deps/db-sync has its own lockfile; without it pnpm installs the upstream root workspace instead.
pnpm install --frozen-lockfile --ignore-workspace
pnpm clean
pnpm release
pnpm build:api-docs
