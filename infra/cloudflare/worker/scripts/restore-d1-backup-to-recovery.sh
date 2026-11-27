#!/usr/bin/env bash
# Restore an owner-decrypted NEO D1 SQL backup into the dedicated recovery D1.
# The age private key stays on the owner's device and is never sent to GitHub.
set -euo pipefail

SOURCE_ID="dd4c03d6-a286-4ac9-abbc-8f162b692acc"
TARGET_ID="a426343d-7c85-4441-a46a-7b7cead38ceb"
TARGET_NAME="neo-staging-recovery-test"
ROOT="$(git rev-parse --show-toplevel)"
BACKUP_DIR="${1:-}"
: "${CLOUDFLARE_API_TOKEN:?Set a narrowly scoped D1 token for neo-staging-recovery-test}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the owner-held private identity file}"

fail() { echo "ERROR: $*" >&2; exit 1; }
[[ -d "$BACKUP_DIR" ]] || fail "Pass the extracted encrypted backup artifact directory as the first argument."
for cmd in age sqlite3 node npm realpath; do command -v "$cmd" >/dev/null 2>&1 || fail "Required command missing: $cmd"; done
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
[[ -s "$AGE_IDENTITY_FILE" ]] || fail "Owner-held age identity file not found."
AGE_IDENTITY_FILE="$(realpath "$AGE_IDENTITY_FILE")"
case "$AGE_IDENTITY_FILE" in "$ROOT"/*) fail "Keep the age private identity outside the repository."; esac
[[ -s "$BACKUP_DIR/neo-staging-db.sql.age" && -s "$BACKUP_DIR/SHA256SUMS" && -s "$BACKUP_DIR/backup-manifest.txt" ]] || fail "Backup artifact is incomplete."
grep -Fqx "Database UUID: $SOURCE_ID" "$BACKUP_DIR/backup-manifest.txt" || fail "Backup source UUID mismatch."
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS) || fail "Encrypted backup checksum failed."
BACKUP_RUN_ID="$(sed -n 's/^Run ID: //p' "$BACKUP_DIR/backup-manifest.txt")"
BACKUP_SHA256="$(awk 'NR==1 {print $1}' "$BACKUP_DIR/SHA256SUMS")"
BACKUP_COMMIT="$(sed -n 's/^Commit: //p' "$BACKUP_DIR/backup-manifest.txt")"
[[ "$BACKUP_RUN_ID" =~ ^[0-9]+$ ]] || fail "Backup run ID is invalid."
[[ "$BACKUP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "Backup commit metadata is invalid."

WORKER_DIR="$ROOT/infra/cloudflare/worker"
CONFIG="$ROOT/infra/cloudflare/wrangler.recovery.local.toml"
[[ ! -e "$CONFIG" ]] || fail "Refusing to overwrite an existing recovery Wrangler config: $CONFIG"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -f "$CONFIG" "$TMP_DIR/neo-staging-db.sql" "$TMP_DIR/source.db" "$TMP_DIR/import.sql"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

umask 077
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$TMP_DIR/neo-staging-db.sql" "$BACKUP_DIR/neo-staging-db.sql.age"
test -s "$TMP_DIR/neo-staging-db.sql" || fail "Decrypted SQL is empty."
sqlite3 "$TMP_DIR/source.db" < "$TMP_DIR/neo-staging-db.sql"
[[ "$(sqlite3 "$TMP_DIR/source.db" 'PRAGMA integrity_check;')" == "ok" ]] || fail "Local source integrity check failed."
[[ -z "$(sqlite3 "$TMP_DIR/source.db" 'PRAGMA foreign_key_check;')" ]] || fail "Local source has foreign-key violations."

cp "$ROOT/infra/cloudflare/wrangler.disposable.example.toml" "$CONFIG"
node --input-type=module - "$CONFIG" <<'NODE'
import fs from "node:fs";
const p=process.argv[2];
let c=fs.readFileSync(p,"utf8");
c=c.replaceAll("REPLACE-WITH-GOOGLE-WEB-CLIENT-ID","recovery-verification-unused.apps.googleusercontent.com");
c=c.replace('database_name = "neo-staging-db"','database_name = "neo-staging-recovery-test"');
c=c.replace('database_id = "dd4c03d6-a286-4ac9-abbc-8f162b692acc"','database_id = "a426343d-7c85-4441-a46a-7b7cead38ceb"');
if(!c.includes('database_name = "neo-staging-recovery-test"') ||
   !c.includes('database_id = "a426343d-7c85-4441-a46a-7b7cead38ceb"') ||
   c.includes('database_id = "dd4c03d6-a286-4ac9-abbc-8f162b692acc"') ||
   c.includes("REPLACE-WITH-")) throw new Error("Recovery-only Wrangler config identity check failed");
fs.writeFileSync(p,c);
NODE

cd "$WORKER_DIR"
npm ci --ignore-scripts --no-audit --no-fund
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 info "$TARGET_NAME" --json --config "$CONFIG" > "$TMP_DIR/target-info.json"
node --input-type=module - "$TMP_DIR/target-info.json" "$TARGET_ID" <<'NODE'
import fs from "node:fs";
const j=JSON.parse(fs.readFileSync(process.argv[2],"utf8")), expected=process.argv[3], ids=[];
function walk(x){if(!x||typeof x!=="object")return;for(const [k,v] of Object.entries(x)){if(["uuid","database_id","databaseId"].includes(k)&&typeof v==="string")ids.push(v);walk(v);}}
walk(j);
if(!ids.includes(expected))throw new Error("Remote recovery database UUID mismatch; refusing restore");
NODE

npx wrangler d1 execute "$TARGET_NAME" --remote --config "$CONFIG" --command "SELECT COUNT(*) AS user_tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';" --json > "$TMP_DIR/empty.json"
node --input-type=module - "$TMP_DIR/empty.json" <<'NODE'
import fs from "node:fs";
const j=JSON.parse(fs.readFileSync(process.argv[2],"utf8")), vals=[];
function walk(x){if(!x||typeof x!=="object")return;if(Array.isArray(x)){for(const v of x)walk(v);return;}for(const [k,v] of Object.entries(x)){if(k==="user_tables"&&typeof v==="number")vals.push(v);walk(v);}}
walk(j);
if(vals.length!==1||vals[0]!==0)throw new Error("Recovery D1 is not provably empty; refusing restore");
NODE

bash "$ROOT/infra/cloudflare/worker/scripts/prepare-d1-import.sh" "$TMP_DIR/source.db" "$TMP_DIR/import.sql"
test -s "$TMP_DIR/import.sql" || fail "Sanitized import SQL is empty."
echo "Preflight passed: source backup verified; remote target UUID matches and is empty; SQL sanitizer produced import."
npx wrangler d1 execute "$TARGET_NAME" --remote --config "$CONFIG" --file="$TMP_DIR/import.sql"
echo "SQL import completed. Comparing restored schema and every table's records against the decrypted source backup..."

node --input-type=module - "$TMP_DIR/source.db" "$TARGET_NAME" "$CONFIG" <<'NODE'
import {spawnSync} from "node:child_process";
import fs from "node:fs";
const [db,target,config]=process.argv.slice(2);
function local(sql){
  const r=spawnSync("sqlite3",["-json",db,sql],{encoding:"utf8"});
  if(r.status!==0)throw new Error("Local SQLite query failed: "+r.stderr);
  return JSON.parse(r.stdout||"[]");
}
function remoteRows(sql){
  const r=spawnSync("npx",["wrangler","d1","execute",target,"--remote","--config",config,"--command",sql,"--json"],{encoding:"utf8"});
  if(r.status!==0)throw new Error("Remote D1 comparison query failed: "+r.stderr);
  const j=JSON.parse(r.stdout), candidates=[];
  function walk(x){
    if(!x||typeof x!=="object")return;
    if(Array.isArray(x)){for(const v of x)walk(v);return;}
    for(const [k,v] of Object.entries(x)){
      if(k==="results"&&Array.isArray(v)&&v.every(row=>row&&typeof row==="object"&&!Array.isArray(row)&&!("results" in row)))candidates.push(v);
      walk(v);
    }
  }
  walk(j);
  if(!candidates.length)throw new Error("Could not parse D1 JSON result rows");
  return candidates.sort((a,b)=>b.length-a.length)[0];
}
const quote=s=>'"'+String(s).replaceAll('"','""')+'"';
const localSchema=local("SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name");
const remoteSchema=remoteRows("SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name");
if(JSON.stringify(localSchema)!==JSON.stringify(remoteSchema))throw new Error("Restored schema differs from the decrypted backup");
const tables=local("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").map(x=>x.name);
for(const table of tables){
  const cols=local("PRAGMA table_info("+quote(table)+")").map(x=>x.name);
  if(!cols.length)throw new Error("Could not inspect columns for "+table);
  const projection=cols.map((c,i)=>"quote("+quote(c)+") AS c"+i).join(",");
  const order=cols.map(quote).join(",");
  const sql="SELECT "+projection+" FROM "+quote(table)+" ORDER BY "+order;
  const a=local(sql), b=remoteRows(sql);
  if(JSON.stringify(a)!==JSON.stringify(b))throw new Error("Restored records differ from backup in table "+table);
}
console.log("Schema objects match: "+localSchema.length);
console.log("Table record contents match: "+tables.length+" tables");
console.log("Migration tracking, if present, was included in the schema and row-by-row comparison.");
NODE

npx wrangler d1 execute "$TARGET_NAME" --remote --config "$CONFIG" --command "PRAGMA integrity_check;" --json > "$TMP_DIR/integrity.json"
node --input-type=module - "$TMP_DIR/integrity.json" <<'NODE'
import fs from "node:fs";
const j=JSON.parse(fs.readFileSync(process.argv[2],"utf8")), strings=[];
function walk(x){if(!x||typeof x!=="object")return;if(Array.isArray(x)){for(const v of x)walk(v);return;}for(const v of Object.values(x)){if(typeof v==="string")strings.push(v);walk(v);}}
walk(j);
if(!strings.includes("ok"))throw new Error("Remote D1 integrity_check did not return ok");
NODE
npx wrangler d1 execute "$TARGET_NAME" --remote --config "$CONFIG" --command "PRAGMA foreign_key_check;" --json > "$TMP_DIR/fk.json"
node --input-type=module - "$TMP_DIR/fk.json" <<'NODE'
import fs from "node:fs";
const j=JSON.parse(fs.readFileSync(process.argv[2],"utf8")), arrays=[];
function walk(x){if(!x||typeof x!=="object")return;if(Array.isArray(x)){for(const v of x)walk(v);return;}for(const [k,v] of Object.entries(x)){if(k==="results"&&Array.isArray(v)&&v.every(row=>row&&typeof row==="object"&&!Array.isArray(row)&&!("results" in row)))arrays.push(v);walk(v);}}
walk(j);
if(!arrays.length||arrays.some(x=>x.length!==0))throw new Error("Remote D1 foreign-key check failed or returned an unrecognized result");
NODE

echo "PASS: recovery database restored and verified against the decrypted backup."
echo "Target: $TARGET_NAME ($TARGET_ID)"
echo "Source staging was never used as a write target. No migrations were applied."
