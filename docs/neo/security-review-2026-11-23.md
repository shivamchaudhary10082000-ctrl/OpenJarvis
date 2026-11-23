# NEO security and integration review

**Review date:** 2026-11-23  
**Reviewed revision:** `54261f0aa6bbef6f239ce8bf60a223ee2dfe26bf`  
**Scope:** Repository-level review of the initial Cloudflare Worker, D1 schema, memory trust path, and client integration primitives.

This is an engineering review of the checked-in source, not a third-party penetration test, Cloudflare deployment assessment, or production security certification. No live account, provider credential, D1 database, or device was accessed.

## Executive assessment

The repository now contains executable Worker handlers and starter Android/web transport primitives. The service is still not ready for real user data or provider credentials. The principal blockers are operational abuse controls, end-to-end authentication tests, and real D1 concurrency tests.

## Findings

### High — No enforceable API rate limits or model spend ceiling

The Worker routes model inference and voice provider requests, but the checked-in implementation still has no durable per-account request quota, token budget, daily/monthly spend ceiling, or provider circuit-breaker state. A valid enrolled device could repeatedly invoke billable endpoints. Worker-isolate memory is not an acceptable enforcement store because isolates are ephemeral and distributed.

**Required remediation:** Add a durable quota design (D1 transactional counters or a per-account Durable Object), explicit fail-closed budget policy, provider timeout/retry ceilings, and tests proving the cap cannot be bypassed by concurrent requests. Keep provider secrets unset until this is complete and owner-approved.

### High — Voice body limit is checked after full buffering

**Patched in this revision:** Access-signed request-body hashing and the voice proxy now use a bounded stream reader. Voice requests are capped at 15 MB; JSON bodies use a validated configured limit capped at 5 MB (default 1 MB). Tests cover the exact boundary, an over-limit streamed body, and an oversized declared Content-Length. The tests have not yet run on this PR head, and a full Worker upload test remains required.

### High — Authentication and D1 trust boundaries lack meaningful integration coverage

The Worker test suite currently proves only the public health route and rejection of a protected route without a bearer token, plus pure cursor, model metadata, and bounded-body-reader helper tests. It does not exercise valid/invalid Access JWT signatures, issuer/audience/expiry, device signatures, nonce replay, revocation, cross-account isolation, or D1-backed memory/task flows.

**Required remediation:** Build deterministic Worker tests with a fake D1 binding and generated P-256/RSA test keys. Cover both allowed and denied cases before staging.

### Medium — Device task claims do not enforce declared capabilities

**Patched in this revision:** Migration `0003_task_capabilities.sql` adds optional task capability requirements. Task creation validates up to 32 unique capability identifiers, and the claim query excludes tasks unless the claiming device advertises every required capability. This still needs D1-backed integration tests with multiple devices and mixed capabilities.

### Medium — Memory revision allocation is vulnerable to concurrent create conflicts

**Patched in this revision:** Memory creation now allocates `MAX(revision)+1` inside the same `INSERT ... SELECT ... RETURNING` statement, removing the separate read/write race. A D1-backed concurrent-create test and stable conflict handling are still required.

### Medium — Provider tier metadata was derived from the candidate array index (patched; CI pending)

The model router previously calculated `tier` and fallback metadata from the loop index. An explicitly selected backup provider became candidate index zero and was incorrectly reported as `primary`.

**Patch in this revision:** Route metadata is now derived from provider identity and whether automatic routing actually moved from an available primary. Focused tests cover explicit backup selection, automatic failover, and backup-only configuration. These tests have not yet been executed by GitHub Actions on the updated PR head.

## Memory sync pagination fix in this revision

The previous cursor used only `(updated_at, memory_id)`. Multiple immutable revisions can share the same second and memory ID, so a page boundary could skip rows. New writes inserted during pagination could also collide with the timestamp-based ordering.

The Worker now uses the D1 implicit `rowid` of the append-only `memory_records` table as its opaque keyset cursor, returning records in insertion order. Cursor encode/decode validation has focused unit tests. This is not yet a D1 integration test; the assumption that memory rows are append-only must remain true. A database rebuild/restore that changes rowids must trigger a full client resynchronisation.

## Staging gate

Do not deploy with real personal data or provider secrets until:

1. The Worker TypeScript check and Vitest suite pass on the updated PR head (not yet verified as of this review).
2. The high-severity findings above are remediated and covered by tests.
3. D1 migrations and concurrency tests pass against a disposable local/staging database.
4. Access JWT, device proof, replay, revocation, and cross-account isolation tests pass.
5. Synthetic-data staging validation and rollback are documented.
6. The owner explicitly approves external Cloudflare resources and provider spending.

## Explicitly not performed

- No production or staging deployment.
- No Cloudflare resource creation, DNS changes, or secrets configuration.
- No provider API calls or paid inference.
- No Android hardware enrolment or microphone test.
- No claim of independent penetration-test completion.
