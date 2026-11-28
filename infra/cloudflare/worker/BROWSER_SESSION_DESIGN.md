# NEO browser session design

Status: implemented on `neo/foundation-architecture`; not yet live. Migration `0011_browser_sessions.sql` is authored but has **not** been applied to remote D1. Automated regression tests are added; final CI is pending. This document remains the behavior contract for review and release.

## Goals

- Exchange a freshly verified Google OIDC identity plus the existing one-time login challenge for a random opaque browser session.
- Keep the raw session secret only in a Secure, HttpOnly, SameSite=Strict cookie; persist only its SHA-256 hash in D1.
- Bind every session to one account, one enrolled browser device and the SHA-256 fingerprint of that device's P-256 public key.
- Preserve Android/native clients' existing Google OIDC + P-256 request-proof path. Do not issue browser cookies to native platforms.
- Make expiry, logout, account/device revocation and cleanup explicit.
- Never silently downgrade from a supplied but invalid session cookie to a bearer token.

## Browser sign-in and session lifecycle

1. Browser requests `GET /v1/auth/challenge` and receives a cryptographically random, short-lived nonce.
2. Google Identity Services returns a Google ID token whose signed `nonce` claim matches that challenge.
3. Browser calls `GET /v1/session` with the ID token only to resolve the namespaced account scope. If a valid same-origin HttpOnly session cookie already exists, this endpoint returns its account and device IDs without requiring a Google token.
4. Browser loads or creates its local P-256 device identity scoped to that account.
5. Browser posts `/v1/devices` with the ID token, device ID, public JWK, platform=`browser`, and capabilities. Worker verifies Google signature/issuer/audience/iat/exp/nonce and atomically consumes the one-use challenge. For an existing device, Worker requires exact account and public-key match and rejects revoked devices.
6. Only after successful new or matching-existing browser enrollment, Worker creates a 256-bit random opaque session token, stores only its SHA-256 hash with account/device/public-key fingerprint, creation/expiry/last-seen timestamps, and returns a cookie:
   `__Host-neo_session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`. The cookie is retained for the 30-day absolute lifetime; the server enforces the seven-day idle timeout and refreshes it on authenticated use.
   No Domain attribute. Cookie is host-only. Responses are `Cache-Control: no-store`.
7. Browser discards the Google ID token from JS memory after session establishment. Subsequent API calls use same-origin credentials and existing P-256 request signatures; they do not send a Google bearer token.
8. On reload, browser first calls `GET /v1/session` with credentials=same-origin. A valid session identifies the device; the client loads the matching non-exportable local private key and resumes. If the local key is absent/mismatched, fail closed and require a new device identity/enrollment.
9. `POST /v1/auth/logout` requires same-origin Origin and Fetch Metadata checks, revokes the current session hash, and clears the cookie. Device revocation invalidates all sessions for that device. Account deactivation invalidates all account sessions.
10. Session expiry is seven days, sliding idle refresh only on authenticated requests, with an absolute maximum lifetime of 30 days. Cleanup removes expired/revoked rows after a short audit retention period.

## Request authentication and CSRF

- A present session cookie is authoritative. Malformed, expired, revoked, device-mismatched or account-mismatched cookies return 401/403 and never fall back to Authorization bearer credentials.
- Session lookup uses SHA-256(token), `revoked_at IS NULL`, expiry and active-account checks.
- Every authenticated request still requires the existing `x-neo-device-id`, timestamp, one-use nonce and P-256 signature. The session must be bound to the same device ID; the device's current stored public key must still match the session fingerprint.
- Unsafe browser methods require `Origin === new URL(request.url).origin` and reject `Sec-Fetch-Site: cross-site`. No wildcard CORS. GET/HEAD are read-only. Do not enable cross-origin credentialed CORS.
- Cookie prefix is `__Host-` (not `__Secure-`) to enforce Secure + Path=/ + no Domain.
- Login endpoint is same-origin only and rate-limited by IP/account. Challenge nonce is single-use. Do not log token, cookie, authorization headers, raw challenge, or signed backup URLs.
- Logout clears the cookie even if the server-side row is already missing.

## Proposed D1 migration (not yet created/applied)

Table `browser_sessions`:
- `session_hash TEXT PRIMARY KEY` (64-char lowercase SHA-256 hex; never raw token)
- `account_id TEXT NOT NULL REFERENCES accounts(account_id)`
- `device_id TEXT NOT NULL REFERENCES devices(device_id)`
- `public_key_hash TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `last_seen_at INTEGER NOT NULL`
- `expires_at INTEGER NOT NULL`
- `absolute_expires_at INTEGER NOT NULL`
- `revoked_at INTEGER`
Indexes on `(account_id, revoked_at, expires_at)`, `(device_id, revoked_at, expires_at)`, and `expires_at`.
No token values, Google ID tokens, or personal profile data are stored.

Migration `0011_browser_sessions.sql` now implements this schema, including foreign keys with cascade deletion, the three lookup/expiry indexes and a partial unique index enforcing one active browser session per device. The staging workflow exact allow-list includes 0011 and checks the table and indexes. This migration is local source only; it has not been applied to remote D1.

## Required automated tests

- Creates cookie only after verified Google token + valid one-use nonce + new or exact matching browser device.
- Rejects invalid signature, issuer, audience, expired token, future iat, missing/wrong/replayed nonce.
- Existing device with wrong account/key or revoked status cannot obtain a session.
- Cookie flags exactly Secure, HttpOnly, SameSite=Strict, Path=/, no Domain; response no-store.
- Only hash is persisted; raw session token never appears in D1 or logs.
- Valid cookie authenticates same device only; cross-device ID/key fails.
- Invalid cookie never falls back to bearer token.
- Expired/revoked session fails; logout revokes and clears; device revocation and account deactivation invalidate sessions.
- Cross-origin unsafe methods and cross-site Fetch Metadata fail; same-origin methods pass.
- Browser reload resumes with cookie + local non-exportable key; clearing IndexedDB or using a different browser fails closed and re-enrols safely.
- Android/native flow remains unchanged and receives no browser cookie.
- Concurrency: one challenge can issue at most one session; duplicate/replayed enrollment requests do not create multiple active sessions without a fresh challenge.

## Rollout and recovery

1. Schema, Worker and browser client implementation are committed together on the engineering branch.
2. Integration tests cover Google nonce-bound session issuance, cookie attributes, hash-only persistence, same-origin enforcement, logout, device revocation and no bearer fallback. Full Worker/Web/Android CI is still required.
3. Deploy the matching Worker and browser assets together only after migration 0011 is approved and applied.
4. A fresh explicit Google sign-in creates the first cookie. An existing enrolled browser device/key is retained when it still matches.
5. On reload, the browser resolves the HttpOnly cookie session and resumes only if its local non-exportable P-256 key matches the server-bound device ID.
6. If cookie/session verification fails, the browser falls back to fresh sign-in; it never falls back silently to bearer authentication after a cookie is supplied.
7. Remote D1 migration is a separate owner-approval gate. No D1 write is permitted until exact SQL, target UUID, durable backup/restore plan and command are presented and approved.

## Explicit non-goals

- No refresh tokens in localStorage or IndexedDB.
- No long-lived Google ID token persistence.
- No cross-origin session sharing.
- No claim that browser sessions protect against XSS; HttpOnly prevents JS token extraction but active same-origin XSS could still issue requests. CSP and dependency hygiene remain required.
