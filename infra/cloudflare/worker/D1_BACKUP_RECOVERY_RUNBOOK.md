# NEO disposable D1 backup and recovery runbook

Status: encrypted GitHub artifact recovery rehearsal added; real staging backup and restore remain unverified.

## Security model and limitations

- Repository is public. Never upload plaintext SQL, credentials, private keys, database contents, or unencrypted backups to repository files, commits, issues, PR comments, or logs.
- GitHub Actions artifacts are short-lived test/rehearsal transport, not durable backups or a substitute for a separately controlled backup system. Access is tied to repository permissions; repository collaborators and authorized readers may access artifacts. Review repository access and artifact retention settings.
- This repository workflow uses only a synthetic SQLite fixture. It has no Cloudflare credentials and never exports, reads, or writes remote D1.
- The private age key for the rehearsal is generated on the ephemeral runner, used only in that run, and is never uploaded or committed. This ephemeral key is intentionally not a reusable backup key.
- Do not store a long-lived private decryption key in the repository, GitHub Actions secrets, workflow artifacts, logs, or runner cache. A real backup design requires an owner-held offline key and a controlled recovery procedure.
- R2 is not a mandatory dependency for this rehearsal or for checksum/decryption/isolated restore tests.

## Rehearsal workflow

Manually run `.github/workflows/neo-d1-artifact-recovery-rehearsal.yml` from the engineering branch.

It:
1. Builds a small synthetic SQLite database and SQL dump on the runner.
2. Generates a throwaway age key pair on the runner.
3. Encrypts the SQL before artifact upload.
4. Uploads only ciphertext and its SHA-256 checksum with one-day retention.
5. Downloads the artifact.
6. Verifies ciphertext checksum.
7. Decrypts with the ephemeral key held only on the runner.
8. Restores to a separate local SQLite file and validates fixture rows.
9. Reports that it is a synthetic rehearsal, not a real staging backup.

## Real D1 backup readiness remains blocked

Latest read-only preflight: [workflow run #45910522233](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45910522233). It verified database `neo-staging-db` / `dd4c03d6-a286-4ac9-abbc-8f162b692acc`, recorded a Time Travel bookmark, completed a private ephemeral SQL export, and found all migrations 0001–0011 pending. The run explicitly skipped backup upload and migration application; no schema changes were made. The Worker health route is green, but database-backed NEO routes remain unavailable until the full migration set is safely applied.


**Important workflow gap:** the current approval-gated D1 workflow has no backup-only mode. Its preflight exports SQL only to the ephemeral runner and does not retain an encrypted backup. Its encrypted R2 backup step is gated by `APPLY_0001_0011` and is followed by schema migrations. Do not set that approval value merely to obtain a backup; doing so also authorizes migration execution. A separate backup-only job must be implemented and reviewed before a real backup can be taken safely.

Required owner-controlled prerequisites for that separate job:
- An age key pair generated and retained by the owner; publish only the age **recipient** (public key) as a GitHub Actions variable. Keep the private key offline and never paste it into chat, GitHub, workflow secrets or logs.
- A private R2 bucket and narrowly scoped R2 object credentials for that bucket.
- A D1 export credential scoped to the exact disposable database, with read/export access only.
- A separately created disposable recovery D1 database and a separate credential scoped to that recovery target. Never use the source database as the restore target.

This rehearsal proves a workflow pattern only. It does not prove that a Cloudflare D1 export is complete, that a real backup can be retained securely, or that an owner-held key can recover staging data.

Before any migration approval:
- Design and review a real export pipeline, with export commands and logs inspected for accidental exposure of signed URLs or SQL.
- Encrypt export before upload, using a securely managed recipient public key; private key must remain offline/owner-held and never be stored in the repository or Actions secrets.
- Consider artifact access restrictions, short retention, retention policy, repository visibility, size limits, deletion behavior, and backup durability. Do not treat a public repository artifact as a durable backup.
- Verify checksum after download, decrypt locally with owner-held key, and restore into an independent disposable D1 database.
- Verify migration history, schema, representative rows, constraints, and foreign keys.
- Keep the real staging D1 untouched during the rehearsal.

## Approval boundary

This workflow does not authorize remote D1 export, restore, schema changes, migrations, Worker deployment, billing activation, or production actions. Those remain separately gated.
