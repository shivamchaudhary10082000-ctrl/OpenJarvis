# Encrypted staging D1 backup (R2-free)

This workflow is intentionally separate from the migration workflow and performs a read-only export of only `neo-staging-db`. It does not apply schema migrations.

## Required GitHub configuration

- Secret: `CLOUDFLARE_D1_BACKUP_TOKEN` — narrowly scoped to the specific staging D1 database with read/export permissions only, if Cloudflare supports that operation scope for the token.
- Variable: `CLOUDFLARE_ACCOUNT_ID`.
- Variable: `NEO_BACKUP_AGE_RECIPIENT` — public age recipient only (`age1...`). Never upload the private key.
- Do not reuse a migration token if a narrower token can be created. Avoid account-wide permissions.

## Run

1. Open Actions > **NEO encrypted disposable D1 backup**.
2. Run workflow and check `confirm_backup`.
3. Wait for completion and download the encrypted artifact ZIP.
4. Artifacts are retained for **30 days only**; this is temporary storage, not a durable backup strategy.
5. On Android, verify the checksum and decrypt with the owner's private age key. Never share the private key or decrypted SQL.
6. Before claiming recovery readiness, restore the decrypted SQL into a separate disposable database and independently verify schema/data. This workflow does not perform that restore.

## Safety boundary

- Exact source database name and UUID are hard-coded and checked.
- No migration commands, D1 write commands, or schema changes are present.
- The SQL export stays on the ephemeral runner as plaintext and is deleted at job end; the workflow uploads only ciphertext and checksum/manifest.
- GitHub artifact storage is not private durable archival. Repository visibility/access policies apply; encryption protects the contents, not metadata.
- If export fails, inspect logs only after checking for accidental signed-URL or plaintext leakage. Wrangler output is captured and withheld.
