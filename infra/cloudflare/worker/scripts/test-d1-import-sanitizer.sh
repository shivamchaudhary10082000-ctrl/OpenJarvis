#!/usr/bin/env bash
set -euo pipefail
script=infra/cloudflare/worker/scripts/prepare-d1-import.sh
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sqlite3 "$tmp/source.db" <<'SQL'
PRAGMA foreign_keys=ON;
CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
INSERT INTO parent VALUES (1,'retain');
INSERT INTO child VALUES (2,1);
CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
INSERT INTO _cf_KV VALUES ('secret','omit');
SQL
sqlite3 "$tmp/source.db" .dump > "$tmp/dump.sql"
bash "$script" "$tmp/source.db" "$tmp/import.sql"
if grep -Eiq 'BEGIN TRANSACTION|COMMIT;|_cf_KV|PRAGMA[[:space:]]+foreign_keys' "$tmp/import.sql"; then echo "sanitizer leaked prohibited statement" >&2; exit 1; fi
sqlite3 "$tmp/restored.db" < "$tmp/import.sql"
test "$(sqlite3 "$tmp/restored.db" 'SELECT value FROM parent WHERE id=1;')" = retain
test "$(sqlite3 "$tmp/restored.db" 'SELECT COUNT(*) FROM child;')" = 1
test "$(sqlite3 "$tmp/restored.db" "SELECT COUNT(*) FROM sqlite_master WHERE name='_cf_KV';")" = 0
test "$(sqlite3 "$tmp/restored.db" 'PRAGMA integrity_check;')" = ok
test -z "$(sqlite3 "$tmp/restored.db" 'PRAGMA foreign_key_check;')"
echo "Sanitizer regression fixture passed"
