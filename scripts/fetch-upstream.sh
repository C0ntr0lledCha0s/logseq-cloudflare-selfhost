#!/usr/bin/env bash
# Usage: fetch-upstream.sh <dest-dir> [ref]
# Clones logseq/logseq at ref (default: UPSTREAM_REF) into a fresh dir and applies patches/*.patch.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${1:?usage: fetch-upstream.sh <dest-dir> [ref]}"
ref="${2:-$(tr -d '[:space:]' < "$repo_root/UPSTREAM_REF")}"
patches_dir="${PATCHES_DIR:-$repo_root/patches}"
upstream_url="https://github.com/logseq/logseq.git"

if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
  echo "refusing: $dest is not empty" >&2
  exit 1
fi

mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
git -C "$dest" init -q
git -C "$dest" remote add origin "$upstream_url"
git -C "$dest" fetch -q --depth 1 origin "$ref"
git -C "$dest" checkout -q FETCH_HEAD

shopt -s nullglob
for patch in "$patches_dir"/*.patch; do
  name="$(basename "$patch")"
  if ! git -C "$dest" apply --check "$patch" 2>&1 || ! git -C "$dest" apply "$patch"; then
    echo "patch failed: $name" >&2
    rm -rf "$dest"
    exit 1
  fi
  echo "applied $name"
done
