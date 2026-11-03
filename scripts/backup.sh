#!/usr/bin/env bash
# Usage: backup.sh <out-dir>   (expects .upstream fetched and `pnpm install` run in .upstream/deps/db-sync)
# Env: WRANGLER (path to wrangler binary), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
#      DB_SYNC_ADMIN_TOKEN, SYNC_HOSTNAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. node and rclone come from PATH.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_arg="${1:?usage: backup.sh <out-dir>}"
: "${WRANGLER:?}" "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${DB_SYNC_ADMIN_TOKEN:?}"
: "${SYNC_HOSTNAME:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"

settings="$repo_root/config/settings.json"
setting() {
  node -e '
    const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof value !== "string" || value === "") { console.error("missing setting: " + process.argv[2]); process.exit(1); }
    process.stdout.write(value);
  ' "$settings" "$1"
}
d1_name="$(setting d1DatabaseName)"
assets_bucket="$(setting assetsBucket)"
backups_bucket="$(setting backupsBucket)"

mkdir -p "$out_arg"
out="$(cd "$out_arg" && pwd)"
mkdir -p "$out/graphs"
log="$out/backup.log"
: > "$log"

download_script="$repo_root/.upstream/deps/db-sync/worker/scripts/download_graph_db.js"
date_dir="$(date -u +%F)"

# wrangler is run from a scratch dir so no wrangler.toml is picked up.
cd "$out"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"

# Dated data lives under daily/<date>/ (the only prefix the lifecycle rule expires).
# rclone copyto has no per-object size cap, unlike `wrangler r2 object put`.
dated_prefix="r2:$backups_bucket/daily/$date_dir"
put() { # <local-file> <key under the dated prefix>
  rclone copyto "$1" "$dated_prefix/$2" >> "$log" 2>&1
}

# 1. D1 export first, uploaded before anything else can fail.
d1_status=ok
if "$WRANGLER" d1 export "$d1_name" --remote --output "$out/index.sql" >> "$log" 2>&1 \
  && put "$out/index.sql" index.sql; then
  echo "d1 export uploaded"
else
  d1_status=fail
fi

# 2. Per-graph snapshots. Files are numbered so ids never reach logs.
graphs_ok=0
graphs_total=0
graphs_status=ok
if ! list_json="$("$WRANGLER" d1 execute "$d1_name" --remote --json --command "select graph_id from graphs" 2>> "$log")" \
  || ! graph_ids="$(printf '%s' "$list_json" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results;
    process.stdout.write(rows.map((r) => r.graph_id).join("\n"));
  ' 2>> "$log")"; then
  graphs_status=fail
  graph_ids=""
fi

index_file="$out/graphs/index.json"
mapping=""
n=0
while IFS= read -r graph_id; do
  [ -n "$graph_id" ] || continue
  n=$((n + 1))
  graphs_total=$n
  mapping="$mapping$n=$graph_id"$'\n'
  file="$out/graphs/$n.sqlite"
  if node "$download_script" --base-url "https://$SYNC_HOSTNAME" --graph-id "$graph_id" --output "$file" >> "$log" 2>&1 \
    && put "$file" "graphs/$n.sqlite"; then
    graphs_ok=$((graphs_ok + 1))
  fi
done <<< "$graph_ids"

printf '%s' "$mapping" | node -e '
  const out = {};
  for (const line of require("fs").readFileSync(0, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  process.stdout.write(JSON.stringify(out));
' > "$index_file"
put "$index_file" graphs/index.json || graphs_status=fail

# 3. Assets mirror. Deleted or overwritten files are moved into the dated area, so a
# deletion in the live bucket never removes the only copy.
assets_status=ok
rclone sync "r2:$assets_bucket" "r2:$backups_bucket/assets" \
  --backup-dir "$dated_prefix/assets-deleted" >> "$log" 2>&1 || assets_status=fail

# 4. Summary, then upload the log (private bucket only) so failures can be diagnosed.
if [ "$graphs_status" = fail ]; then
  graphs_summary="fail"
else
  graphs_summary="$graphs_ok/$graphs_total"
fi
summary="backup: d1=$d1_status graphs=$graphs_summary assets=$assets_status"
echo "$summary" >> "$log"
log_status=ok
put "$log" backup.log || log_status=fail
echo "$summary log=$log_status"

if [ "$d1_status" = ok ] && [ "$graphs_status" = ok ] && [ "$graphs_ok" -eq "$graphs_total" ] && [ "$assets_status" = ok ]; then
  exit 0
fi
echo "backup failed; see $backups_bucket/daily/$date_dir/backup.log"
exit 1
