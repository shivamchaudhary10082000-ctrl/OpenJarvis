# NEO security and integration review

**Review date:** 2026-11-23  
**Reviewed revision:** `aaa2c024a6e3685cabaab9ad7244ae63741a85df`  
**Scope:** Repository-level review of the initial Cloudflare Worker, D1 schema, memory trust path, and client integration primitives.

This is an engineering review of the checked-in source, not a third-party penetration test, Cloudflare deployment assessment, or production security certification. No live account, provider credential, D1 database, or device was accessed.

## Executive assessment

The repository now contains executable Worker handlers and starter Android/web transport primitives. The service is still not ready for real user data or provider credentials. The principal blockers are operational abuse controls, end-to-end authentication tests, and real D1 concurrency tests.

## Findings

### High — No enforceable API rate limits or model spend ceiling

The Worker routes model inference and voice provider requests, but the checked-in implementation has no durable per-account request quota, token budget, daily/monthly spend ceiling, or provider circuit-breaker state. A valid enrolled device could repeatedly invoke billable endpoints. Worker-isolate memory is not an acceptable enforcement store because isolates are ephemeral and distributed.

**Required remediation:** Add a durable quota design (D1 transactional counters or a per-account Durable Object), explicit fail-closed budget policy, provider timeout/retry ceilings, and tests proving the cap cannot be bypassed by concurrent requests. Keep provider secrets unset until this is complete and owner-approved.

### High — Voice body limit is checked after full buffering

`voiceRoute` calls `req.arrayBuffer()` before checking the 15 MB limit. An oversized request is therefore fully buffered before rejection. The generic JSON body limit does not protect this route.

**Required remediation:** Reject an excessive declared Content-Length early and enforce a streaming byte limit while reading the body. Test missing, misleading, and oversized Content-Length cases.

### High — Authentication and D1 trust boundaries lack meaningful integration coverage

The Worker test suite currently proves only the public health route and rejection of a protected route without a bearer token, plus pure cursor helper tests. It does not exercise valid/invalid Access JWT signatures, issuer/audience/expiry, device signatures, nonce replay, revocation, cross-account isolation, or D1-backed memory/task flows.

**Required remediation:** Build deterministic Worker tests with a fake D1 binding and generated P-256/RSA test keys. Cover both allowed and denied cases before staging.

### Medium — Device task claims do not enforce declared capabilities

The task-claim query selects the oldest queued task for an account and leases it to the calling device without matching task requirements to `devices.capabilities_json`. This can assign work to a device that did not advertise the required capability.

**Required remediation:** Define a validated capability schema and task capability requirement, then atomically claim only tasks the device is allowed and able to execute.

### Medium — Memory revision allocation is vulnerable to concurrent create conflicts

Memory creation reads `MAX(revision)+1` and then inserts in a separate statement. Two concurrent requests for the same account and memory ID can calculate the same revision; one will fail at the primary key constraint. This is fail-safe against silent overwrite, but the API currently returns a generic bad request rather than a deterministic conflict/retry response.

**Required remediation:** Make revision allocation atomic (for example, a D1 batch/transaction with a guarded insert strategy) and return a stable 409 conflict on contention. Add concurrent integration tests.

### Medium — Provider tier metadata is derived from the candidate array index

The model router calculates `tier` and fallback metadata from the loop index. When a user explicitly selects the configured backup provider, that provider becomes candidate index zero and is reported as `primary`, despite being the backup. This is an observability and user-disclosure correctness defect.

**Required remediation:** Derive the provider tier from provider identity, and derive `fallback_used` from whether automatic routing actually moved from the configured primary. Add explicit-backup and automatic-fallback tests.

## Memory sync pagination fix in this revision

The previous cursor used only `(updated_at, memory_id)`. Multiple immutable revisions can share the same second and memory ID, so a page boundary could skip rows. New writes inserted during pagination could also collide with the timestamp-based ordering.

The Worker now uses the D1 implicit `rowid` of the append-only `memory_records` table as its opaque keyset cursor, returning records in insertion order. Cursor encode/decode validation has focused unit tests. This is not yet a D1 integration test; the assumption that memory rows are append-only must remain true. A database rebuild/restore that changes rowids must trigger a full client resynchronisation.

## Staging gate

Do not deploy with real personal data or provider secrets until:

1. The Worker TypeScript check and Vitest suite pass on the updated PR head.
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
