# NEO Worker security review and staging readiness

Reviewed against the engineering branch after commit `b90852c9e7abaf7e8a9d267301583dc636a86dea`.

## Current code and CI evidence

- Worker CI run #248 on commit `6694cb561a5e3390b7727f142d4ecac0d67129c2` passed TypeScript checking, Wrangler dry-run, OpenAPI lint, Worker tests and browser persistence tests.
- The latest branch includes a staging-workflow action upgrade to `actions/checkout@v7` and `actions/setup-node@v6`; the resulting full CI runs are still being evaluated.
- Google ID-token validation checks RS256 signature, issuer, audience, issued-at and expiry. First-device Google enrollment uses a short-lived, one-use server nonce.
- Device requests use enrolled P-256 keys, signed request canonicalization, timestamp bounds and one-use nonces.
- Rate limiting, bounded bodies, memory revisions, task leases and provider spend reservation/settlement controls are implemented and covered by automated tests.
- Staging provider URLs/credentials are unset and monthly USD/input/output token budgets are zero.

## Confirmed D1 preflight evidence

Workflow run #36 (`45781211390`) completed successfully against the intended disposable target:

- Database: `neo-staging-db`
- Database UUID: `dd4c03d6-a286-4ac9-abbc-8f162b692acc`
- Time Travel bookmark recorded.
- SQL export completed and was checked for non-zero size on the ephemeral GitHub runner.
- Remote migration list was inspected and showed no pending migrations in that run.
- Migration apply and Worker deploy steps were skipped. **No remote schema changes were made.**

Important limitations:
- The SQL export existed only on the ephemeral runner and was not retained as a durable private backup.
- The old run printed a temporary signed export URL in the public Actions log. The URL was time-limited; do not reuse or repeat it. Commit `6694cb561a5e3390b7727f142d4ecac0d67129c2` changed the workflow to suppress Wrangler export output. That suppression still needs a fresh preflight to verify.
- The current approval file is `NO`. No migration is authorized.

## Authentication/session findings

- The browser obtains a Google ID token through Google Identity Services and keeps it in JavaScript memory only; it is not persisted in IndexedDB.
- Browser requests currently send that Google ID token as a bearer credential.
- `GET /v1/session` validates the identity token and returns the account subject. It does **not** create a server-managed session.
- There is no opaque, revocable browser session cookie or server-side session table yet.
- Browser API assets and Worker API are served from the same origin. No wildcard CORS policy is configured. Cookie-based mutation CSRF/origin enforcement is not implemented because cookie sessions do not yet exist.
- The current integration tests cover Google OIDC validation, challenge replay rejection, browser device enrollment through identity assertions, device proof replay, account isolation, heartbeat and revocation. They do not prove a real deployed Google login or a persistent browser session.

A proper browser session exchange needs a reviewed design and a new migration (session hash, account/device binding, expiry and revocation), HttpOnly/Secure/SameSite cookie handling, same-origin mutation checks, logout/revocation and focused tests. Do not claim session hardening complete until those changes and tests pass.

## Live staging status

- An earlier disposable deployment run #2 deployed commit `0676cb8a3a414e7b6fcfec04607d11728301653e`; its health probe returned `status=ok` for `disposable-staging`.
- That deployment predates later OIDC challenge and migration changes. The current engineering head is **not deployed**.
- Deployment runs #36, #37, #38 and #40 skipped their deployment jobs as expected because no staging-deploy approval marker was supplied.
- Current live D1 schema state has not been independently verified.
- Real Google sign-in, first-device enrollment, authenticated browser operations, Android-to-browser sync and recovery have not been verified against the current Worker.

## Remaining release gates

1. Complete and independently test the opaque browser-session design.
2. Finish the full CI set on the latest branch head; investigate any failures rather than relying on old green runs.
3. Establish a durable private backup destination. A public repository artifact or unencrypted public backup is not acceptable. D1 Time Travel is a useful short-retention recovery layer, not the only backup.
4. Update the migration set and exact approval workflow for any new session schema.
5. Run a fresh read-only preflight with the signed-URL log suppression in place; verify target UUID, remote migration list, Time Travel bookmark and private backup.
6. Present the exact migration set, SQL effects, backup, restore/rollback method and command to the owner. Obtain explicit approval before any remote D1 write.
7. Apply only the approved migrations to the hard-coded disposable D1 UUID and verify migration history, tables, columns, indexes and triggers.
8. Deploy the current Worker/browser assets to `neo-api-disposable-staging` only, then verify health and authenticated operations.
9. Test login challenge, enrollment, signed heartbeat, revocation, replay rejection, memory sync, task lease conflict, zero-budget provider blocking and browser persistence.
10. Reset approval to `NO`, then revoke/remove temporary migration credentials after use.

## Permission and safety boundaries

- No main merge, production deployment, release publication, billing activation or provider calls.
- No remote D1 writes without a separate, explicit owner approval after a detailed preflight and migration plan.
- The temporary migration token previously configured for this task has account-wide D1 Write scope because the UI did not offer the intended database-level selector. It must not be used; it is due to expire on 2026-12-03. Do not create another broad token as a workaround.
- The existing Worker-only deployment token is separate and must not be reused for D1.
- Do not modify the user's separate Supabase physiotherapy project.
