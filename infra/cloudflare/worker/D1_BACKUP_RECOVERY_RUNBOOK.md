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
