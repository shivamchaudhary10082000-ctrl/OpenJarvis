# NEO Worker security review and staging readiness

Reviewed against the current engineering branch. This document distinguishes source implementation from remote staging verification.

## Current code and CI evidence

- Worker CI run #248 on commit `6694cb561a5e3390b7727f142d4ecac0d67129c2` passed TypeScript checking, Wrangler dry-run, OpenAPI lint, Worker tests and browser persistence tests. This is baseline evidence, not verification of the new browser-session implementation.
- The staging workflow uses `actions/checkout@v7` and `actions/setup-node@v6`, removing the prior Node.js 20 deprecation warning.
- Latest changes add browser session issuance/enforcement, migration 0011, browser restore/sign-out, and regression tests. The first Worker CI attempt found a TypeScript error in the extended API error helper; this was fixed. A subsequent complete Worker CI run on the final branch head is still required.
- Google ID-token validation checks RS256 signature, issuer, audience, issued-at and expiry. Google browser sign-in uses a short-lived, one-use server nonce.
- Device requests continue to require enrolled P-256 keys, signed request canonicalization, timestamp bounds and one-use nonces.
- Rate limiting, bounded bodies, memory revisions, task leases and provider spend reservation/settlement controls remain in place.
- Staging provider URLs/credentials are unset and monthly USD/input/output token budgets are zero.

## Browser session implementation on the engineering branch

Implemented in source (not yet deployed):

- `POST /v1/devices` creates a browser session only after Google ID-token validation and one-use OIDC challenge consumption; an existing browser device must match the same account and P-256 public key.
- The opaque 256-bit cookie token is returned as `__Host-neo_session` with Path=/, Secure, HttpOnly and SameSite=Strict. Only its SHA-256 hash is stored in D1.
- Migration `0011_browser_sessions.sql` creates account/device-bound sessions, idle expiry (7 days), absolute expiry (30 days), revocation fields, lookup indexes and a unique partial index allowing one active session per device.
- Every authenticated browser API request remains bound to the same device ID and P-256 request signature. Session key fingerprint is checked against the current enrolled device key.
- A supplied invalid/expired/revoked cookie is authoritative and never falls back to a bearer token.
- Unsafe cookie-authenticated requests require exact same-origin `Origin` and reject `Sec-Fetch-Site: cross-site`. Logout revokes the current hash and clears the cookie.
- Device revocation revokes its browser sessions. Inactive accounts cannot use sessions. Expired/revoked sessions are eligible for scheduled cleanup after a 30-day retention window.
- Browser client drops the Google ID token after session exchange, restores the cookie session on reload only when the local non-exportable P-256 key matches, and has a sign-out control.
- Native clients retain their existing OIDC/device-proof path and do not receive browser cookies.

Automated integration tests have been added for nonce-bound Google session issuance, cookie flags, hash-only storage, session bootstrap, cross-origin rejection, logout, device revocation and no bearer downgrade. **These tests are not considered passed until the Worker CI run on the current branch head completes successfully.**

## D1 migration status and preflight evidence

Workflow run #36 (`45781211390`) completed a read-only preflight against the intended disposable target:

- Database: `neo-staging-db`
- Database UUID: `dd4c03d6-a286-4ac9-abbc-8f162b692acc`
- Time Travel bookmark recorded.
- SQL export completed and was checked for non-zero size on the ephemeral GitHub runner.
- Remote migration list was inspected and showed no pending migrations at that time.
- Migration apply and Worker deploy steps were skipped. **No remote schema changes were made.**

Important limitations:
- The SQL export existed only on the ephemeral runner and was not retained as a durable private backup.
- The old run printed a temporary signed export URL in the public Actions log. The URL was time-limited; do not reuse or repeat it. Commit `6694cb561a5e3390b7727f142d4ecac0d67129c2` changed the workflow to suppress Wrangler export output. That suppression still needs a fresh preflight verification.
- Migration `0011_browser_sessions.sql` is new source and is not applied remotely.
- `D1_MIGRATION_APPROVAL.txt` remains `NO`. No migration is authorized.

## Durable backup status

- A private encrypted R2 backup runbook exists at `D1_BACKUP_RECOVERY_RUNBOOK.md`.
- No R2 bucket has been created, no R2 token has been issued, and no durable backup has been uploaded or restored.
- The next owner-side resource setup is a private bucket `neo-staging-d1-backups`, plus an R2 API token restricted to that bucket (Object Read + Object Write only). It must have no D1 or Workers permissions.
- Backup encryption must occur on the runner before upload; the decryption private key must remain owner-held and outside GitHub.
- No SQL export or backup is to be stored in this public repository or as a public Actions artifact.

## Live staging status

- An earlier disposable deployment run #2 deployed commit `0676cb8a3a414e7b6fcfec04607d11728301653e`; its health probe returned `status=ok` for `disposable-staging`.
- That deployment predates the current OIDC/session changes. The current engineering head is **not deployed**.
- Latest deployment workflow jobs are skipped unless the explicit disposable-staging deployment gate is supplied. No deployment has been triggered by this work.
- Current live D1 schema state has not been independently verified.
- Real Google sign-in, first-device enrollment, cookie issuance, authenticated browser operations, Android-to-browser sync and recovery have not been verified against the current Worker.

## Remaining release gates

1. Complete the full Worker CI on the current branch head and fix any failures; then complete Web and Android harness CI.
2. Review the integrated diff and session tests independently.
3. Owner creates the private R2 bucket and bucket-scoped token; configure secrets without sharing them in chat.
4. Implement and verify encrypted backup upload + download/decrypt/restore rehearsal against a separate disposable database.
5. Run a fresh read-only D1 preflight with the signed-URL log suppression in place; verify target UUID, remote migration list, Time Travel bookmark and durable private backup.
6. Present exact migration 0011 SQL, affected objects, target UUID, backup ID/hash, recovery procedure and command. Obtain explicit owner approval before any remote D1 write.
7. Apply only approved migration 0011 to the hard-coded disposable D1 UUID and verify migration history, table, columns, indexes and foreign keys.
8. Deploy current Worker/browser assets to `neo-api-disposable-staging` only, then verify health and real Google login, session issue/resume/logout and device operations.
9. Test challenge replay, device proof replay, revocation, memory sync, task lease conflicts and zero-budget provider blocking.
10. Reset approval to `NO`; revoke/remove the temporary broad migration credential after its use/expiry.

## Permission and safety boundaries

- No main merge, production deployment, release publication, billing activation or provider calls.
- No remote D1 writes without a separate, explicit owner approval after a detailed preflight and migration plan.
- The temporary migration token previously configured has account-wide D1 Write scope because the UI did not offer a database-level selector. It must not be used for backup or staging deployment; it is due to expire on 2026-12-03. Do not create another broad token as a workaround.
- The existing Worker-only deployment token is separate and must not be reused for D1 or R2.
- Do not modify the user's separate Supabase physiotherapy project.
