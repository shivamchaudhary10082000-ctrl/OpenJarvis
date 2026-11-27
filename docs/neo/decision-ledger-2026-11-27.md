# NEO engineering decision ledger

Updated: 2026-11-27

## Active route: no R2 activation

R2 subscription activation is deferred. Do not prompt the owner to activate R2 or create an R2 bucket as part of this route. Proceed with code-level and synthetic encrypted backup/recovery pipeline testing that requires no Cloudflare resource activation, no billing changes, and no live D1 write.

This is a deliberate decision, not a temporary step to be repeatedly reconsidered.

## Current constraints

- Continue only on `neo/foundation-architecture` / Draft PR #1.
- Keep `main`, production and releases untouched.
- No Cloudflare resources or billing activation.
- No paid AI provider.
- No Supabase modifications; it is a separate project.
- Remote staging D1 `neo-staging-db` UUID `dd4c03d6-a286-4ac9-abbc-8f162b692acc` remains uninitialized; migrations 0001–0011 are pending.
- Keep `infra/cloudflare/D1_MIGRATION_APPROVAL.txt` at `NO`.
- Never put owner-held age private key in GitHub, repository, runner or chat.

## Present backup/recovery route

Use synthetic fixtures to test encryption, ciphertext checksums, decryption, isolated restore, and validation. This rehearsal is not a backup of live staging and does not satisfy durable-backup or migration prerequisites.

Remote staging backup, owner-held decryption, isolated recovery-D1 restore, and migration are blocked until the owner explicitly chooses and enables an appropriate durable storage route and credentials. Do not bypass this gate or silently substitute GitHub artifacts for durable recovery.

## Next engineering work

1. Improve and test backup-only workflow safeguards and synthetic recovery tests.
2. Review exact source-D1 identity guards and secret/log handling.
3. Strengthen migration verification logic in code without executing remote migrations.
4. Continue real OAuth/device/session/chat code-level tests, with mock/local boundaries disclosed.
5. Report concrete evidence and blockers; avoid repeating completed checks unless new evidence requires it.
