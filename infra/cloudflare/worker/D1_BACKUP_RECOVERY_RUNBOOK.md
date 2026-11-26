# NEO disposable D1 backup and recovery runbook

Status as of 2026-11-27: **real staging backup and restore are blocked; no NEO migrations have been applied to the remote database.**

## Scope and protected resources

- Source: disposable Cloudflare D1 database `neo-staging-db`, UUID `dd4c03d6-a286-4ac9-abbc-8f162b692acc`.
- Recovery must use a separate disposable D1 database and a separate credential. Never restore over the source database.
- The repository is public. Never place plaintext SQL, database rows, credentials, signed URLs, private keys, or unencrypted backups in repository files, commits, issues, pull requests, logs, or public Actions artifacts.
- The age private key remains owner-held/offline. Only its public age recipient may be stored as a GitHub Actions variable. Never put the private key in GitHub secrets, the repository, a runner, an artifact, or chat.
- No bucket, credential, or recovery database may be created by this workflow. If the existing private R2 bucket and least-privilege credentials cannot be proven, stop before backup or migration.

## Latest read-only preflight evidence

Workflow run [#45910522233](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45910522233), job `140217498701`, completed successfully:

1. Confirmed the D1 UUID matches the hard-coded disposable target.
2. Retrieved a D1 Time Travel bookmark.
3. Exported SQL to the ephemeral runner; Wrangler output was redirected so its short-lived signed download URL was not written to public logs.
4. Inspected the remote migration list: **migrations 0001–0011 are pending**.
5. Skipped R2 upload and skipped all schema writes. No remote migration was applied.
6. `infra/cloudflare/D1_MIGRATION_APPROVAL.txt` is `NO`.

The export was temporary runner data, not a durable backup. A Time Travel bookmark is not a substitute for the required encrypted, independently recoverable backup.

## Current workflow limitation — do not use APPLY to obtain a backup

The current `.github/workflows/neo-disposable-staging.yml` has two relevant behaviors:

- `PREFLIGHT_ONLY` verifies the target, exports SQL to the ephemeral runner, lists migrations, and skips R2 upload and schema writes.
- `APPLY_0001_0011` enables the R2 encryption/upload/download-checksum step and then immediately applies migrations 0001–0011 when that step succeeds.

There is **no backup-only mode and no pause for owner-held decryption plus isolated restore verification**. Therefore the existing apply path cannot satisfy the required backup → download/checksum → owner decrypt → separate restore rehearsal → migration sequence. Do not set `APPLY_0001_0011` merely to get a backup.

The existing apply workflow also does not yet provide a complete post-migration proof of all 11 migration-history entries and every foreign-key definition. Its current checks cover a subset of core tables, provider/OIDC triggers, and browser-session indexes. A future apply run must strengthen and record the full schema verification before it can be considered complete.

## Credentials and R2 status

- The last successful preflight used the existing D1 migration credential for read/export. The previously inspected token had account-wide D1 Write scope because Cloudflare's permission UI did not offer the desired database-level selector. That is not an acceptable least-privilege credential for this recovery operation. Do not reuse it as a workaround or broaden any permission.
- The preflight did not run the R2 step. The repository has no successful evidence of an R2 upload, R2 download, or owner-held restore. The current GitHub connector cannot reveal secret values or enumerate the Cloudflare account's R2 buckets, so an unexecuted step must not be treated as proof that the bucket or credentials exist.
- Required before proceeding: an existing private R2 bucket; bucket-scoped Object Read + Object Write credentials only; a D1 read/export credential restricted as narrowly as Cloudflare permits to the exact disposable source; the public age recipient; and a separate disposable recovery D1 target with a separately scoped credential.
- Do not reuse the Worker deployment token for D1 or R2. Do not use the broad D1 Write token for a backup. Do not create a new bucket, recovery database, or broader token under this authorization.

## Required recovery sequence

1. Add a separate, reviewed **backup-only** workflow path. It must use read/export-only D1 access and bucket-scoped R2 object access; it must never apply migrations.
2. Verify the exact source UUID before export. Keep Wrangler's signed export URL and SQL output out of logs.
3. Encrypt the SQL on the ephemeral runner with the owner's public age recipient before upload. Upload only ciphertext to the existing private R2 bucket.
4. Download the same object again and verify the ciphertext SHA-256. Record the object key, source UUID, ciphertext hash, UTC time, and workflow run ID.
5. Owner downloads the ciphertext and decrypts it offline using the owner-held private key. Never transmit that key to the runner.
6. Restore the decrypted SQL into a different disposable recovery D1 database, not the source. Verify the restore's migration history, tables, indexes, triggers, foreign-key definitions, and `PRAGMA foreign_key_check`; retain evidence tied to the same backup object and hash.
7. Only after that restore is proven may the already-authorized disposable-source migration sequence be enabled. The apply workflow must verify that its restore attestation refers to the exact backup hash and source UUID, re-check the target UUID, apply only migrations 0001–0011, and leave the approval file at `NO` afterwards.
8. Verify all 11 migration-history entries; all expected tables, indexes and triggers; expected foreign-key relationships; and zero foreign-key violations. Do not enable scheduled maintenance until verification is complete.

## Synthetic artifact rehearsal is not staging recovery

`.github/workflows/neo-d1-artifact-recovery-rehearsal.yml` creates a synthetic local SQLite fixture, encrypts it with an ephemeral throwaway key, uploads ciphertext and checksum as a one-day GitHub Actions artifact, downloads it, verifies the checksum, decrypts it, and restores the fixture to another local SQLite file. It has no Cloudflare credentials and does not read or write remote D1. Its ephemeral key is not the owner's recovery key. This only exercises a pipeline pattern; it is not a backup or restore of `neo-staging-db`.

## Approval boundary

Keep `D1_MIGRATION_APPROVAL.txt` at `NO` until the backup and isolated restore are independently proven. No remote schema write, migration, production deployment, billing change, paid model-provider activation, or change to the separate Supabase physiotherapy project is authorized by this runbook.
