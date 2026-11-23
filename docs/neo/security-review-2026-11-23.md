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
