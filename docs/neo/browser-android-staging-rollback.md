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

An installable **local-only diagnostic harness** now exists at `infra/cloudflare/clients/android-test-harness`. It is not the production NEO Android app and does not connect to the Worker, use a microphone, enrol a real account, or encrypt real user data.

### Manual physical-device evidence — 2026-11-24

The owner installed the diagnostic APK on an Android phone and reported:
- Android Keystore created/verified a P-256 identity and signed a request.
- A synthetic outbox record was queued in SQLite.
- After closing and reopening the app, SQLite recovered the same record ID and idempotency key.
- The record was deleted successfully.
- A second signing check after app restart passed.

**Still unproven manually:** the last output did not include a stable public-key fingerprint, so it did not establish that the exact same key pair was reused after restart. A follow-up change now displays a SHA-256 fingerprint derived from the public P-256 coordinates. Install the APK from the CI run containing that change, record the fingerprint, force-stop/reopen the app, run the identity check again, and compare the fingerprints. Do not share private-key material; the fingerprint is public-key-only.

### Remaining physical-device matrix

1. Repeat the identity fingerprint check across app restart and full device reboot.
2. Force-stop and reboot with a queued synthetic record; confirm it remains recoverable.
3. Exercise SQLite corruption, low-storage and app-data-clear behavior; document when re-enrolment is required.
4. Test a second Android vendor/device when available.
5. For the real client (not this harness), test airplane mode, background/foreground recovery, HTTP 429/503, timeout, process death during flush, 409 idempotency conflict, device B sync, device A revocation, and re-enrolment after app-data loss.
6. Verify backup exclusion on the actual production Android host app. The diagnostic harness manifest sets `android:allowBackup="false"`; that setting does not automatically configure a future host app.

The current harness only validates local key operations and synthetic SQLite persistence. It does not prove end-to-end encryption, real device enrolment, network synchronization, offline AI, background retries or cross-device memory sharing.

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


## Automated native-client harnesses (2026-11-24)

- Android harness: `infra/cloudflare/clients/android-test-harness`. Unit tests cover SQLite outbox persistence across store reconstruction, account-scoped database isolation and plaintext/invalid-idempotency rejection. Emulator instrumentation covers Keystore P-256 identity persistence/signing across client instances and SQLite recovery.
- Browser harness: `infra/cloudflare/worker/test/native-browser`. Playwright runs the real IndexedDB client in Chromium, Firefox and WebKit, including non-exportable CryptoKey persistence, encrypted memory cache recovery and idempotent outbox replay after reload.
- Latest completed baseline PR head `ffe4a44529e5ad2d49a8a90c9c22d45668f51912` passed Android unit and emulator instrumentation jobs, plus the browser matrix. A new Android fingerprint diagnostic was committed at `6436d374aa61c8b9a67bd7b1bdcf9697547029dc`; its CI run is in progress and must pass before distributing the updated APK.
