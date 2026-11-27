# NEO disposable D1 backup and recovery runbook

Status as of 2026-11-27: **real staging backup and restore are blocked; no NEO migrations have been applied to the remote database.**

## Scope and protected resources

- Source: disposable Cloudflare D1 database `neo-staging-db`, UUID `dd4c03d6-a286-4ac9-abbc-8f162b692acc`.
- Recovery must use a separate disposable D1 database and a separate credential. Never restore over the source database.
- The repository is public. Never place plaintext SQL, database rows, credentials, signed URLs, private keys, or unencrypted backups in repository files, commits, issues, pull requests, logs, or public Actions artifacts.
- The age private key remains owner-held/offline. Only its public age recipient may be stored as a GitHub Actions variable. Never put the private key in GitHub secrets, the repository, a runner, an artifact, or chat. The backup/recovery path uses encrypted GitHub Actions artifacts and an owner-local restore script; it has no R2 dependency.

## Latest read-only preflight evidence

Workflow run [#45910522233](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45910522233), job `140217498701`, completed successfully:

1. Confirmed the D1 UUID matches the hard-coded disposable target.
2. Retrieved a D1 Time Travel bookmark.
3. Exported SQL to the ephemeral runner; Wrangler output was redirected so its short-lived signed download URL was not written to public logs.
4. Inspected the remote migration list: **migrations 0001–0011 are pending**.
5. Skipped R2 upload and skipped all schema writes. No remote migration was applied.
6. `infra/cloudflare/D1_MIGRATION_APPROVAL.txt` is `NO`.

The export was temporary runner data, not a durable backup. A Time Travel bookmark is not a substitute for the required encrypted, independently recoverable backup.

## Migration gate behavior

The current `.github/workflows/neo-disposable-staging.yml` keeps migration apply separate from backup and restore:

- `PREFLIGHT_ONLY` verifies the source UUID, records a Time Travel bookmark, exports SQL only to ephemeral runner storage, and lists migration state. It does not change schema.
- `APPLY_0001_0011` is rejected unless `D1_RESTORE_ATTESTATION.txt` explicitly records `RESTORE_VERIFIED=YES` with the exact source and recovery UUIDs.
- Before applying, the workflow checks the attested backup run is a successful manual run of the exact backup workflow on `neo/foundation-architecture`, downloads the referenced encrypted artifact, and verifies its checksum, source UUID and run ID against the attestation.
- The owner-held age private identity is never placed in GitHub. The local restore script must have completed schema and record comparison, integrity checks and foreign-key validation before the owner records the attestation.
- Both `D1_MIGRATION_APPROVAL.txt` and `D1_RESTORE_ATTESTATION.txt` remain `NO` by default. No migration is authorized by a successful backup alone.

Do not set `APPLY_0001_0011` merely to obtain a backup. Use the separate encrypted backup-only workflow and owner-local restore process first.

## Credentials and artifact storage status

- The last successful preflight used the existing D1 migration credential for read/export. The previously inspected token had account-wide D1 Write scope. That is not acceptable as a least-privilege recovery credential. Do not reuse it as a workaround or broaden permissions.
- No R2 bucket is part of this design. Encrypted GitHub Actions artifacts are used instead; only ciphertext, checksum and non-sensitive metadata are uploaded.
- The backup workflow requires a separate D1 export credential scoped to the exact disposable source, plus the public age recipient.
- The owner-local restore script requires a separate D1 write credential scoped only to the newly created recovery database. The private age identity stays on the owner's device and is never added to GitHub.
- Do not reuse the Worker deployment token for D1. Do not use the broad D1 Write token for backup or restore.

## Required recovery sequence

1. Use the backup-only workflow to export the exact staging D1 UUID. It must never apply migrations.
2. Encrypt the SQL on the ephemeral runner with the owner's public age recipient before upload to the time-limited GitHub Actions artifact.
3. Download the same artifact to the owner's device and verify the ciphertext SHA-256.
4. Decrypt locally with the owner-held private key. Never transmit that key to the runner, GitHub, repository, artifact, or chat.
5. Run `infra/cloudflare/worker/scripts/restore-d1-backup-to-recovery.sh` locally. The script checks the source UUID, local SQLite integrity, exact recovery D1 UUID and empty-target precondition; it restores only to the recovery database; then compares schema definitions and all table row contents with the decrypted source and checks remote integrity and foreign keys.
6. Retain the exact backup run ID, SHA-256 and successful restore output as evidence.
7. Only after restore evidence is reviewed may the already-authorized disposable-source migration sequence be considered. The apply workflow must be re-reviewed to require a restore attestation tied to the exact backup hash and source UUID.
8. Verify all 11 migration-history entries; all expected tables, indexes and triggers; expected foreign-key relationships; and zero foreign-key violations. Do not enable scheduled maintenance until verification is complete.

## Synthetic artifact rehearsal is not staging recovery

`.github/workflows/neo-d1-artifact-recovery-rehearsal.yml` creates a synthetic local SQLite fixture, encrypts it with an ephemeral throwaway key, uploads ciphertext and checksum as a one-day GitHub Actions artifact, downloads it, verifies the checksum, decrypts it, and restores the fixture to another local SQLite file. It has no Cloudflare credentials and does not read or write remote D1. Its ephemeral key is not the owner's recovery key. This only exercises a pipeline pattern; it is not a backup or restore of `neo-staging-db`.

## Approval boundary

Keep `D1_MIGRATION_APPROVAL.txt` at `NO` until the backup and isolated restore are independently proven. No remote schema write, migration, production deployment, billing change, paid model-provider activation, or change to the separate Supabase physiotherapy project is authorized by this runbook.
