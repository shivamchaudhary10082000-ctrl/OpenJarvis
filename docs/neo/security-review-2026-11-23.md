# NEO security and integration review

**Review date:** 2026-11-23  
**Scope:** Source-level review of the Cloudflare Worker, D1 migrations 0001–0008, provider budget controls, web/Android client primitives and local integration tests.

This is not a third-party penetration test, production certification, remote D1 validation or Cloudflare staging assessment. No live account, provider credential, production data or device was accessed.

## Executive verdict

**Partial — not release ready.** The source now includes meaningful security boundaries and 48 passing local Worker tests. It also includes fail-closed financial/token budgets and ciphertext-only offline queues. However, no remote resources are deployed, real provider behavior is untested, Android is not built/tested on a device, and operational recovery/security controls remain incomplete.

## Controls implemented and tested locally

- Access JWT RS256 verification with issuer, audience and expiry checks.
- P-256 device request proof, timestamp window and nonce replay rejection.
- Account/device binding, cross-account denial, enrolment and revocation.
- Device heartbeat and online/offline freshness reporting.
- D1 per-account rate limiting.
- Encrypted memory revision allocation, idempotent offline replay and cross-account isolation.
- Task idempotency, capability-aware claims, concurrent lease race and expired-lease recovery.
- Atomic monthly spend reservations, concurrent reservation cap, settlement guard and monthly token-budget reservations.
- Primary/backup failover, explicit model no-fallback, allow_fallback=false, provider network failure and mocked voice transcription/synthesis.
- CI run #106 passed on PR head `9e2d2fd4783cfc77c3cdc3cea9e3eed664e71922`: Redocly OpenAPI lint, TypeScript check, Wrangler deployment dry-run and 48 tests across 3 files. Added fake-IndexedDB persistence/reconstruction/outbox tests, 90-second heartbeat expiry/recovery, and voice upstream-timeout reservation accounting.

## Residual findings

### High — Financial configuration is intentionally disabled until owner approval

Non-test Wrangler values for monthly spend, monthly input/output tokens, model pricing and voice request ceilings are zero. Provider/voice routes therefore fail closed. This is correct for the current unapproved state.

**Remaining risk:** Pricing is manually configured and may become stale when model IDs or provider prices change. Caps are per account; they do not form a global aggregate ceiling for a shared provider API key across multiple accounts.

**Required before enabling:** Select providers/models, verify current official pricing, set an owner-approved monthly USD cap plus input/output token caps, set conservative voice maximum costs for the 15 MB upload boundary, and add budget alerts/review cadence. Keep provider keys unset until then.

### High — Settlement over-reservation requires manual reconciliation

D1 triggers reject monetary or token settlement above the reservation. The request fails closed and the reservation remains held, preventing further requests from consuming the same budget.

**Remaining risk:** There is no automated reconciliation or operator UI to investigate and release/adjust a stranded reservation. A provider response with malformed or unexpectedly high usage can therefore block the account until manually reviewed.

### High — No remote staging or recovery evidence

Local SQLite-backed D1 tests do not prove remote D1 behavior, Cloudflare Access configuration, secrets, DNS, migrations, deployment, rollback, backup restore or deletion propagation.

**Required:** Stage with a dedicated account, apply all eight migrations, verify Access issuer/audience, test backup/restore and rollback, then perform controlled security tests before any production rollout.

### Medium — Provider/voice tests are mocked

The tests verify routing and request accounting against mocks. They do not establish real provider compatibility, actual usage reporting, timeout charging semantics, rate-limit response formats, transcription duration billing or synthesis response streaming.

**Required:** After budget and credentials are explicitly approved, test with low hard caps and provider sandbox credentials. Verify each provider's usage fields and billing semantics.

### High — Desktop dependency audit is currently failing

The latest repository security workflow failed its Rust advisory gate for `frontend/src-tauri/Cargo.lock`: `cookie 0.18.1` is affected by RUSTSEC-2026-0594 (private-cookie AES-GCM nonce reuse under a specific fork/thread deployment pattern). The advisory's documented exploit preconditions are unusual and may not match the current Tauri desktop process model, but the dependency is still flagged and the CI gate is red. The fixed release identified by the advisory is `cookie 0.18.3`. Upgrade the dependency through its parent Tauri dependency graph, regenerate the lockfile, and rerun the full desktop build/advisory checks; do not suppress this advisory without a documented applicability review.

### Medium — Browser same-origin script execution remains a risk

The web client re-imports its P-256 private key as non-exportable before persistence, and namespaces identity/cache/outbox by a hashed account scope. The Android starter similarly scopes its Keystore alias, SharedPreferences device ID and SQLite database by account. Non-exportable storage does not protect against same-origin XSS that can invoke signing or read Access tokens.

**Required:** Strict CSP, dependency pinning/audit, Trusted Types where applicable, no unsafe inline scripts, secure Access-token lifecycle, recovery/re-enrolment and browser persistence tests. Fake IndexedDB tests now cover basic storage/recovery, but the CryptoKey clone behavior uses a test adapter; native browser matrix testing remains.

### Medium — Android source is not a tested application

A bookkeeping defect in `flushOutbox()` that left the reported sent count at zero was corrected. This is source-only; no Kotlin compile or real-device test is available.

The Android client uses Android Keystore and SQLite for ciphertext-only offline data, but the repository has no Android Gradle app/test project. Kotlin compilation, SQLite migrations, background execution, key invalidation, backup exclusion and real-device behavior remain unverified.

### Medium — Offline replay is caller-driven

Web IndexedDB and Android SQLite persist encrypted memory/task outbox items with idempotency keys. A caller must invoke flushOutbox; there is no background retry scheduler, exponential backoff, connectivity listener, conflict-resolution UI or local inference fallback.

### Medium — D1 and device operational hygiene

Expired device nonces are removed by a 15-minute scheduled Worker task. Settled spend reservations are retained for audit; held reservations still require operator reconciliation. Device presence is refreshed by signed requests and a 90-second heartbeat window, but there is no autonomous health monitor or durable device capability grant/revocation workflow.

## Security boundary and deployment decision

- Do not add provider secrets or user data yet.
- Do not provision paid inference or deploy to production.
- Keep PR #1 Draft.
- Complete staging migration/rollback/restore tests, real provider cost verification, Android/browser validation and an independent penetration test before release.


## 2026-11-24 follow-up

The desktop lockfile has been updated from `cookie 0.18.1` to patched `0.18.3` using the registry-published checksum. This removes the known vulnerable version from the lockfile as authored, but the finding remains **pending verification** until the Rust advisory workflow and desktop build complete successfully on the updated PR head.

A Gradle Android test harness and Playwright browser-native IndexedDB matrix have been added. Their CI runs are pending; do not describe them as passing until workflow evidence is reviewed. Emulator validation is not a physical-device matrix.

Remote Cloudflare staging/rollback/restore and independent penetration testing remain unperformed. No Cloudflare account resources or production systems were changed.


## 2026-11-24 verification update

- The suspended-account first-enrolment regression test and account-status guard are present on the active PR branch. Worker CI passed on commit `507eea87d1d15071bd92c3c1a5c68b959770f77d`, including TypeScript, OpenAPI lint, Wrangler dry-run, Vitest and the native Playwright browser suite (Chromium, Firefox and WebKit). This verifies the source/test branch in CI; it is not a live-host CSP or authentication test.
- The Android harness unit-test job passed on that same commit. The emulator instrumentation job was still running at the time of this update. Physical Android hardware testing remains required.
- Browser source review confirms the NEO transport accepts an Access-token callback and does not intentionally persist the token in IndexedDB. Non-exportable CryptoKeys do not mitigate same-origin XSS. No production-host CSP headers or actual NEO sign-in callback have been validated. The existing desktop Tauri CSP also contains broad `connect-src http: https: ws: wss:` and `script-src 'unsafe-inline'`; this is not an acceptable template for the NEO browser origin and needs a separate desktop CSP compatibility review before tightening.
- Voice tests currently cover primary/backup failover accounting, no-fallback behavior, provider connection failure, transcription timeout without retry, successful transcription, and successful synthesis. They are mocked and do not prove live provider billing.
- A conservative stale-reservation reconciler has now been added to the Worker scheduled handler. Reservations older than 30 minutes are settled at their full reserved USD and token ceilings rather than released, because a provider may have billed a request even if the Worker died before receiving the response. A regression test verifies trigger-based ledger reconciliation, preservation of fresh reservations and idempotent repeated runs. This new code/test is **pending CI** and is not yet counted as verified.
- Phase 1 remains open until the new reconciliation test passes, Android emulator instrumentation and physical-device recovery are validated, and the real frontend hosting/token/CSP boundary is verified. Remote staging is intentionally blocked until those gates close.


## 2026-11-24 CI follow-up — reconciliation assertion corrected

The first Worker CI run for the new reconciliation code reached the test suite but failed one assertion: the helper correctly reconciled more than one stale reservation because the D1 test database is shared across the integration suite. The test incorrectly assumed exactly one stale reservation existed globally. The assertion now verifies at least one stale reservation is reconciled, then verifies the second pass reconciles zero and separately checks the test reservation's exact settled amounts and the fresh reservation's held state.

The corrected test is on PR head `816b1f0ee99b81627cef0836ff047efdcd39ccb3`. Worker CI run #? and Android harness run #? were queued when this note was authored; no pass is claimed until they finish.

The Android API-36 emulator harness had an earlier run where unit tests passed but emulator boot/instrumentation remained in progress. A subsequent harness run is queued. Do not count Android recovery as verified until `connectedDebugAndroidTest` succeeds.

**Browser-hosting gate remains blocked by a missing deployment boundary:** the NEO browser code is a transport/storage library and is not integrated into the existing Tauri frontend. The repository contains no NEO browser-host deployment origin or server response-header configuration. Therefore a CSP header cannot be responsibly enforced yet; choosing a policy without knowing the actual script, API, auth, websocket, telemetry and asset origins risks either breaking the app or leaving broad unsafe allowances. The current Tauri CSP is not evidence of a secure browser-host CSP.

**Token lifecycle gate:** the browser client accepts a caller-supplied access-token callback and does not itself persist tokens. There is no integrated login/refresh/sign-out/recovery provider flow to audit end-to-end. Keep the eventual provider token in memory only, refresh through the identity provider, clear it on sign-out, and revoke the device on account recovery; validate the actual integration before Phase 1 closure.

Phase 1 remains open. No Cloudflare resources were provisioned and no application build was started.
