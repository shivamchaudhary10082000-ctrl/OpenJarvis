#!/usr/bin/env bash
# Convert a validated SQLite database into SQL accepted by Cloudflare D1.
# Cloudflare's reserved _cf_KV table is intentionally omitted.
set -euo pipefail

INPUT_DB="${1:-}"
OUTPUT_SQL="${2:-}"
[[ -s "$INPUT_DB" ]] || { echo "ERROR: SQLite input database is missing." >&2; exit 1; }
[[ -n "$OUTPUT_SQL" ]] || { echo "ERROR: Output SQL path is required." >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "ERROR: sqlite3 is required." >&2; exit 1; }

sqlite3 "$INPUT_DB" .dump | awk '
  BEGIN { skip_cf_table = 0 }
  {
    line = tolower($0)
    if (!skip_cf_table && line ~ /^create table( if not exists)?[[:space:]]+["_]?_cf_kv["]?([[:space:]]|[(])/) {
      skip_cf_table = 1
      if (line ~ /\)[[:space:]]*(without rowid)?;[[:space:]]*$/) skip_cf_table = 0
      next
    }
    if (skip_cf_table) {
      if (line ~ /\)[[:space:]]*(without rowid)?;[[:space:]]*$/) skip_cf_table = 0
      next
    }
    if (line ~ /^(insert into|replace into|delete from)[[:space:]]+["_]?_cf_kv["]?([[:space:]]|[(])/) next
    if (line ~ /^[[:space:]]*(begin transaction|commit);?[[:space:]]*$/) next
    if (line ~ /^[[:space:]]*pragma foreign_keys[[:space:]]*=/) next
    print
  }
' > "$OUTPUT_SQL"

[[ -s "$OUTPUT_SQL" ]] || { echo "ERROR: Sanitized D1 import SQL is empty." >&2; exit 1; }
if grep -Eiq 'CREATE TABLE.*_cf_KV|INSERT INTO.*_cf_KV|BEGIN TRANSACTION|COMMIT;' "$OUTPUT_SQL"; then
  echo "ERROR: Sanitized SQL still contains a D1-incompatible transaction wrapper or reserved _cf_KV table." >&2
  exit 1
fi
