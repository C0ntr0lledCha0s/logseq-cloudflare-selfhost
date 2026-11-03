#!/usr/bin/env bash
# Usage: vendor-upstream-api.sh <upstream-dir>
# Copies the semantic API tool definitions and OpenAPI spec from a built upstream checkout
# into connector/vendor/ and records the upstream commit in connector/vendor/UPSTREAM_REF.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="${1:?usage: vendor-upstream-api.sh <upstream-dir>}"
dest="$repo_root/connector/vendor"

files=(
  "deps/db-sync/worker/semantic_api_tools.mjs"
  "deps/db-sync/worker/dist/openapi.json"
)

for f in "${files[@]}"; do
  if [ ! -f "$upstream/$f" ]; then
    echo "missing $upstream/$f (build upstream first)" >&2
    exit 1
  fi
done

ref="$(git -C "$upstream" rev-parse HEAD)"

mkdir -p "$dest"
for f in "${files[@]}"; do
  cp "$upstream/$f" "$dest/$(basename "$f")"
done
printf '%s\n' "$ref" > "$dest/UPSTREAM_REF"
echo "vendored upstream API at $ref into connector/vendor/"
