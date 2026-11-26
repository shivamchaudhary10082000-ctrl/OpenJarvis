# NEO Worker security review and staging readiness

Reviewed against branch commit `459e6ca3e0f6ee0f7eea4e7e2d554d1cd19ab656`.

## CI evidence
- Worker TypeScript check, dry-run, Worker test suite and browser persistence tests passed on the latest branch commit.
- Google ID-token and Cloudflare Access JWT validation, issuer/audience/expiry/signature validation, challenge checks are implemented.
- Device requests use enrolled P-256 keys, signed request canonicalization, timestamp bounds and nonces.
- Rate limiting, bounded bodies, memory revisions, task leases and spend reservation/settlement logic exist.
- Provider spend/token caps are configured to zero in the staging template; keep inference blocked until budget/pricing is reviewed.

## Live verification
- Live staging health was not independently confirmed in this review.
- Latest disposable staging workflow had both migration and deployment jobs skipped.
- Remote D1 migration state is not verified; do not assume migrations 0001-0010 are applied.
- Browser sign-in, enrollment, signed requests, memory sync and recovery have not been confirmed on deployed Worker.

## Hardening gaps to close
1. Confirm browser auth/session model in a real browser. Avoid JS-accessible persisted bearer credentials; prefer HttpOnly, Secure, SameSite server-managed sessions and CSRF controls where architecture supports it. `/session` currently returns identity; it is not itself a session exchange.
2. Verify origin/CSRF policy for browser mutation endpoints and restrictive CORS.
3. Verify challenge issuance limits, expiration, one-time consumption and recovery against live D1.
4. Verify nonce cleanup/replay rejection, revocation, rate limits and task lease conflict behavior live.
5. Verify reservation/settlement and stale reconciliation; no real providers while budget is zero.
6. Review logs/responses for secret/token leakage.
7. Verify exact disposable Worker and D1 configuration before deploying; avoid generic configuration.

## Safe staging sequence
1. Verify branch and disposable configuration identity (Worker, D1 name/UUID, environment).
2. Inspect migration set and remote migration list.
3. Obtain Time Travel bookmark and private backup before schema changes.
4. Run migration preflight only with separately scoped token.
5. Review preflight and require explicit approval before applying migrations.
6. Apply only approved migrations; verify schema.
7. Deploy Worker/browser assets to disposable staging only.
8. Verify health and exercise login challenge, enrollment, heartbeat, revocation, memory sync, task lease, zero-budget model blocking and browser persistence.
9. Reset approval marker and revoke/remove temporary migration token.

## Boundaries
No main/production merge, billing activation, provider calls or remote D1 schema changes performed.
