# NEO security and integration review

**Review date:** 2026-11-23  
**Reviewed revision:** `2f4f0db87030704535e993b6a6a9f384182ef5e3`  
**Scope:** Repository-level review of the initial Cloudflare Worker, D1 schema, memory trust path, and client integration primitives.

This is an engineering review of the checked-in source, not a third-party penetration test, Cloudflare deployment assessment, or production security certification. No live account, provider credential, D1 database, or device was accessed.

## Executive assessment

The repository now contains executable Worker handlers and starter Android/web transport primitives. The service is still not ready for real user data or provider credentials. The principal blockers are operational abuse controls, end-to-end authentication tests, and real D1 concurrency tests.

## Findings

### High — No hard provider spend ceiling; request rate limit added, D1 integration tests pending

**Patched in this revision:** A D1-backed fixed-window per-account rate limiter now applies to authenticated device requests and first-device enrolment (default 60 requests/minute, configurable up to 600). SQLite-level validation confirmed the counter rejects request 61 and resets in the next minute. This still needs a real D1 integration test.

**Still unresolved:** There is no durable token budget or hard daily/monthly provider spend ceiling. Rate limiting alone does not cap financial exposure. A valid enrolled device can still consume a large amount within the allowed request rate.

**Required remediation:** Define the provider, model pricing, maximum request/output sizes, and owner-approved monthly budget; then implement a fail-closed D1 reservation/reconciliation design and concurrent cap tests. Keep provider secrets unset until this is complete and owner-approved.

### High — Voice body limit is checked after full buffering

**Patched in this revision:** Access-signed request-body hashing and the voice proxy now use a bounded stream reader. Voice requests are capped at 15 MB; JSON bodies use a validated configured limit capped at 5 MB (default 1 MB). Tests cover the exact boundary, an over-limit streamed body, and an oversized declared Content-Length. The tests have not yet run on this PR head, and a full Worker upload test remains required.

### High — Authentication and D1 trust boundaries lack meaningful integration coverage

The Worker test suite currently proves only the public health route and rejection of a protected route without a bearer token, plus pure cursor, model metadata, and bounded-body-reader helper tests. It does not exercise valid/invalid Access JWT signatures, issuer/audience/expiry, device signatures, nonce replay, revocation, cross-account isolation, or D1-backed memory/task flows.

**Required remediation:** Build deterministic Worker tests with a fake D1 binding and generated P-256/RSA test keys. Cover both allowed and denied cases before staging.

### Medium — Device task claims do not enforce declared capabilities

**Patched in this revision:** Migration `0003_task_capabilities.sql` adds optional task capability requirements. Task creation validates up to 32 unique capability identifiers, and the claim query excludes tasks unless the claiming device advertises every required capability. This still needs D1-backed integration tests with multiple devices and mixed capabilities.

### Medium — Memory revision allocation is vulnerable to concurrent create conflicts

**Patched in this revision:** Memory creation now allocates `MAX(revision)+1` inside the same `INSERT ... SELECT ... RETURNING` statement, removing the separate read/write race. A D1-backed concurrent-create test and stable conflict handling are still required.

### Medium — Browser device signing key was exportable (patched; browser integration test pending)

The web client previously generated an extractable private P-256 key, exported it to JWK, then re-imported it as non-extractable. The private key therefore existed in exportable form in application memory.

**Patch in this revision:** Generate the key pair as non-extractable and persist the CryptoKey directly in IndexedDB; only the public JWK is exported. Browser storage is still exposed to same-origin script execution, so a production web client needs a strict CSP, dependency/XSS controls, secure Access-token handling, and a documented device recovery/re-enrolment path.
### Medium — Provider tier metadata was derived from the candidate array index (patched; CI pending)

The model router previously calculated `tier` and fallback metadata from the loop index. An explicitly selected backup provider became candidate index zero and was incorrectly reported as `primary`.

**Patch in this revision:** Route metadata is now derived from provider identity and whether automatic routing actually moved from an available primary. Focused tests cover explicit backup selection, automatic failover, and backup-only configuration. These tests have not yet been executed by GitHub Actions on the updated PR head.

## Memory sync pagination fix in this revision

The previous cursor used only `(updated_at, memory_id)`. Multiple immutable revisions can share the same second and memory ID, so a page boundary could skip rows. New writes inserted during pagination could also collide with the timestamp-based ordering.

The Worker now uses the D1 implicit `rowid` of the append-only `memory_records` table as its opaque keyset cursor, returning records in insertion order. D1 BLOB ciphertext and nonce values are converted back to unpadded base64url strings at the API boundary so browser/Android clients receive the declared wire format. Cursor encode/decode validation has focused unit tests. This is not yet a D1 integration test; the assumption that memory rows are append-only must remain true. A database rebuild/restore that changes rowids must trigger a full client resynchronisation.

## Staging gate

Do not deploy with real personal data or provider secrets until:

1. The Worker TypeScript check and Vitest suite pass on the updated PR head (not yet verified as of this review).
2. The D1-backed rate-limit and spend-budget enforcement tests pass.
3. The remaining high-severity findings above are remediated and covered by tests.
4. D1 migrations and concurrency tests pass against a disposable local/staging database.
5. Access JWT, device proof, replay, revocation, and cross-account isolation tests pass.
6. Synthetic-data staging validation and rollback are documented.
7. The owner explicitly approves external Cloudflare resources and provider spending.

## Explicitly not performed

- No production or staging deployment.
- No Cloudflare resource creation, DNS changes, or secrets configuration.
- No provider API calls or paid inference.
- No Android hardware enrolment or microphone test.
- No claim of independent penetration-test completion.
