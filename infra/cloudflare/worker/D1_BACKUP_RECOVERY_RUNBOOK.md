# NEO disposable D1 backup and recovery runbook

Status: design/runbook only. No backup bucket has been created and no backup has been uploaded.

## Current state and reason this is a release blocker

- Repository visibility is public. Do not store SQL exports, encryption keys, database contents, or backup artifacts in repository files, commits, issues, PR comments, or public logs.
- Previous D1 preflight exported SQL to an ephemeral GitHub Actions runner and checked that the file was non-empty. That is not a durable backup.
- Cloudflare D1 Time Travel bookmark was recorded in preflight run #36, but Time Travel is a bounded recovery feature, not a retained independent backup.
- The temporary D1 migration credential has account-wide D1 Write scope. It is not acceptable for recurring backup automation and must not be used for backup writes.

## Recommended private backup destination

Use a dedicated private Cloudflare R2 bucket, separate from the NEO Worker and D1 database.

Required owner-side setup before automation:
1. Create a private bucket named `neo-staging-d1-backups` in the same Cloudflare account. Do not enable public access or a custom public domain.
2. Create an R2 API token scoped only to this bucket, with Object Read + Object Write (no bucket administration, no D1 permissions, no Workers permissions). Prefer short expiry and rotate it after backup setup.
3. Add the R2 credentials as GitHub Actions secrets `NEO_R2_ACCESS_KEY_ID` and `NEO_R2_SECRET_ACCESS_KEY`. Add repository variables `NEO_R2_BUCKET_NAME` and `NEO_BACKUP_AGE_RECIPIENT`. Never paste credentials into chat or commit them.
4. Generate an age key pair locally. Store only the public recipient string in `NEO_BACKUP_AGE_RECIPIENT`; retain the private identity outside GitHub (password manager or offline secure storage). Never add the private identity to GitHub.
5. The staging migration workflow now refuses any D1 apply unless it can encrypt the ephemeral SQL export with age, upload ciphertext to the configured R2 bucket, download it again, and verify the ciphertext SHA-256. It writes only the object key and checksum to the Actions summary. No R2 secrets or bucket are configured yet, so the apply gate cannot pass.
6. After upload, owner must independently download and decrypt the backup and rehearse SQL restore against a separate disposable D1 database. CI does not have the owner-held private key and cannot claim this restore test.
7. Agree on retention, e.g. daily 14 days + weekly 8 weeks, and lifecycle deletion on the bucket. Keep the bucket private and enable object versioning if available.

## Backup object contract

- Object key: `neo-staging-d1/YYYY/MM/DD/neo-staging-db-<UTC timestamp>.sql.age`.
- Export output and logs remain in runner temp storage only; suppress Wrangler output because it may print a signed R2 download URL.
- Encrypt the SQL file before upload. Upload only ciphertext.
- Record a small non-sensitive manifest alongside the encrypted object: database UUID, UTC timestamp, migration history, SQL ciphertext SHA-256, encryption format/version and workflow run URL. Do not include secrets, signed URLs, raw SQL, or session tokens.
- Verify remote object size and download/decrypt/checksum in an isolated recovery test. A successful upload alone is not proof of recoverability.
- Never use a public GitHub Actions artifact as the durable backup destination for this public repository.

## Restore / rollback

- D1 Time Travel restore and SQL re-import are different recovery mechanisms. Select the correct one only after identifying the incident and current schema/data state.
- Before any schema write, capture a new Time Travel bookmark and a fresh encrypted private export.
- Test restore against a separate disposable D1 database first. Never test restore on production or the source staging database.
- A SQL import is not automatically transactional across all migration files. Restore into a new disposable DB, validate schema + representative row counts + foreign keys/triggers, then change staging binding only with explicit approval.
- Keep the previous Worker deployment/config available for code rollback. Code rollback cannot reverse a destructive schema change; migrations must be additive/forward-fixable or have a rehearsed restore.
- Document exact restore command, bucket/object identifier, decryption procedure, expected migration version and verification queries before requesting migration approval.

## Required checks before migration approval

- Private bucket is not publicly readable.
- R2 token scope is limited to this bucket and has no D1 write permission.
- Backup file is encrypted before upload; only ciphertext reaches R2.
- Object exists with non-zero size and matching SHA-256 manifest.
- Recovery test downloads ciphertext, decrypts using the owner-held key and validates SQL against a separate disposable D1 database.
- Time Travel bookmark and private backup identifiers are recorded in the protected workflow summary (never a signed URL).
- Retention and expiry behavior are known.

## Approval boundary

Creating a bucket, issuing an R2 token, uploading a backup, restoring data, changing a D1 binding, or modifying a remote database are external resource/data operations. Do not perform them without the owner's explicit approval. This runbook does not authorize those operations.
