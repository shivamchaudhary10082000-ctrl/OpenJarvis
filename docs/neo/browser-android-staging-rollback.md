# NEO browser, Android, staging and rollback validation

**Status:** preparation only. No remote Cloudflare resources were created or changed.

## Browser IndexedDB validation

Automated tests live in `infra/cloudflare/worker/test/browser-storage.test.ts`. They use a fresh IndexedDB implementation and cover:
- non-exportable device identity persistence after client reconstruction;
- account-scope separation;
- encrypted approved-memory cache recovery after simulated offline restart;
- durable ciphertext-only outbox replay with the same idempotency key after reconstruction.

The tests must pass in the NEO Worker CI before treating browser persistence as verified. They are not a substitute for testing Chrome, Firefox, Safari, Android WebView and storage eviction/private-browsing behavior.

## Android physical-device test plan

There is no Android Gradle application/test harness or attached Android device in this repository session. Do not claim a real-device pass. Once the host app exists, run on at least one current Pixel/AOSP device and one Samsung device:

1. Install a debug build; enrol device A; create an encrypted memory item and queue an encrypted task.
2. Enable airplane mode; force-stop the app; reboot the device.
3. Reopen the app offline; confirm approved cached memory is readable and pending outbox items remain queued.
4. Re-enable connectivity; invoke outbox flush; confirm each item is accepted once and removed only after a successful response.
5. Repeat with HTTP 429, HTTP 503, timeout, process death during flush, and a 409 idempotency conflict. A conflict must remain visible for operator/user resolution, not be silently discarded.
6. Enrol device B to the same account; verify shared server memory and device-specific local queues.
7. Revoke device A while online; verify subsequent signed requests fail. Document that a disconnected device cannot receive remote wipe/revocation until it reconnects.
8. Clear app data and reinstall; verify key loss triggers re-enrolment rather than reusing a stale server device ID.
9. Verify SQLite database and preferences are excluded from Android cloud/device backup, or explicitly document the recovery policy.

The Android source currently persists ciphertext, uses an account-scoped SQLite database and Keystore identity. The outbox success counter was corrected; no Android compile or physical-device test has yet run.

## Browser security review

### Current source-level observations
- NEO's browser client obtains an Access token through a caller-supplied callback; it does not intentionally persist the token in its IndexedDB stores.
- Device signing keys are stored as non-exportable CryptoKey objects. Same-origin script execution can still ask the key to sign and can call the token callback; non-exportability does not neutralize XSS.
- Memory cache and outbox are account-scoped and intended to contain encrypted payloads only.
- The NEO client is a transport/storage primitive. The hosting frontend's actual response headers, authentication callback implementation and deployment origin must be reviewed before enabling it.

### Required hosting controls
- Start with a **Content-Security-Policy-Report-Only** header on the real frontend host; collect violations and remove incompatible inline/eval behavior before enforcement.
- Enforce a restrictive CSP with `default-src 'self'`, explicit `script-src` sources/nonces, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, and narrowly scoped `connect-src`. Do not copy this as a blind drop-in: required API, telemetry, worker and asset origins must be inventoried first.
- Prefer nonce/hash-based scripts; do not add `unsafe-eval`. Avoid `unsafe-inline` for scripts. Add Trusted Types where the browser/app stack supports it.
- Keep Access tokens in memory or a vetted secure session flow; never localStorage/sessionStorage, URL parameters, logs or analytics. Refresh through the authentication provider; clear in-memory tokens and revoke device access on sign-out/recovery.
- Pin and audit dependencies; review Markdown/HTML rendering, URL handling, service-worker update behavior and any unsafe HTML sinks.
- Test CSP in report-only, then enforce in staging; validate sign-in, voice, websocket/API, PWA update and desktop webview paths.

No CSP has been deployed because the actual frontend hosting boundary and required origin inventory have not yet been confirmed.

## Disposable Cloudflare staging

Template: `infra/cloudflare/wrangler.disposable.example.toml`.

1. Create a dedicated non-production Cloudflare account/project or isolated D1 database. Never reuse production data.
2. Create a dedicated Cloudflare Access application and record its issuer domain and audience.
3. Create a D1 database named `neo-disposable-staging`; put its ID in the example config (copy to a local untracked config if preferred).
4. Replace the Access placeholders. Keep all provider URLs/keys empty and all monetary/token/voice budgets at zero.
5. Run local validation first: npm audit, Redocly lint, TypeScript check, tests and Wrangler dry-run.
6. Apply migrations 0001–0008 to the remote disposable D1; verify the remote migration list.
7. Deploy only the disposable config, configure the Access application to protect the Worker hostname, then test health, auth denial, device enrol/revoke, heartbeat expiry, memory, task leases and rate limits.
8. Do not add provider secrets or enable paid inference during the first staging pass.

Suggested commands (after placeholders are replaced and Cloudflare authentication is explicitly established):

```sh
cd infra/cloudflare/worker
npm ci
npm audit --audit-level=moderate
npx --yes @redocly/cli@2.82.0 lint ../openapi.yaml
npm run check
npm test
npm run deploy:dry-run
# Then, only against the dedicated disposable account/database:
npx wrangler d1 migrations apply neo-disposable-staging --remote --config ../wrangler.disposable.example.toml
npx wrangler deploy --config ../wrangler.disposable.example.toml
```

The example config is deliberately not deployable while its D1 ID and Access values are placeholders.

## Rollback and recovery rehearsal

Perform this only in disposable staging:

1. Export the D1 database before applying migrations and store the export outside the repository in an access-controlled location.
2. Record the currently active Worker deployment/version and smoke-test it.
3. Deploy a candidate Worker and run health, auth, device, memory, task, voice-disabled and spend-disabled smoke tests.
4. Simulate a bad Worker release. Use the Cloudflare dashboard's Worker deployment/version rollback to restore the previously recorded Worker version; verify health and authenticated operations.
5. Do not assume application rollback reverses D1 migrations. Migrations are additive/forward-only for this project. For a schema/data recovery exercise, restore the pre-change export into a separate fresh disposable D1 database, point a separate Worker at it, and verify record counts and account isolation.
6. Verify device revocation, idempotency, pending outbox replay and reservation ledger integrity after rollback/restore.
7. Record timestamps, deployment IDs, migration list, test outcomes and any data loss window. Destroy the disposable Worker, Access application and D1 database after evidence is retained safely.

No Cloudflare deployment, remote migration, export, rollback or resource deletion was performed in this session. These steps require the owner's Cloudflare account access and explicit approval.

## Release gates

- Worker and browser IndexedDB CI green on the same PR head.
- Android build/test harness and physical-device results attached.
- CSP enforced and token lifecycle reviewed on the real frontend host.
- Disposable staging migration, Access, smoke, rollback and restore rehearsal recorded.
- Independent security assessment completed.
- Keep provider and voice budgets at zero until provider/model, pricing and spend limits are explicitly approved.


## Added automated native-client harnesses (2026-11-24; CI pending)

- Android harness: `infra/cloudflare/clients/android-test-harness`. Unit tests cover SQLite outbox persistence across store reconstruction, account-scoped database isolation and plaintext/invalid-idempotency rejection. An emulator instrumentation test covers Android Keystore P-256 identity persistence and signing across client instances.
- Browser harness: `infra/cloudflare/worker/test/native-browser`. Playwright runs the real IndexedDB client in Chromium, Firefox and WebKit, including non-exportable CryptoKey persistence, encrypted memory cache recovery and idempotent outbox replay after reload.
- CI workflows are configured for both harnesses. Their status must be checked on the latest PR head before claiming success. The emulator is not a substitute for real Pixel/Samsung device testing.
