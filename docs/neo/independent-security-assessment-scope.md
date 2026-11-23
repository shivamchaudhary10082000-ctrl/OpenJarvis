# NEO independent security assessment scope

**Status:** assessment brief only. No independent assessor has been engaged and no penetration test has been performed.

## Objective

Obtain an independent assessment of NEO's multi-device identity, Cloudflare Worker API, D1 state transitions, encrypted memory/offline synchronization, provider routing and client persistence before any production rollout.

The assessor must be independent of the implementation team. Internal code review, GitHub Actions, static analysis and AI-assisted testing do not satisfy this requirement.

## Authorised target boundary

The assessment must use a dedicated disposable Cloudflare account/project, a dedicated Cloudflare Access application, a disposable D1 database and test-only accounts/devices. No production hostname, production D1, production user data, paid provider key or real user device may be in scope.

Before testing, the owner and assessor must agree in writing on:
- exact Worker hostname, Access app and D1 database identifiers;
- test account identities and allowed source IPs;
- testing window, rate ceiling and emergency contact;
- permitted denial-of-service intensity (default: none);
- data retention and evidence handling;
- explicit stop conditions and cleanup owner.

## Required test areas

### 1. Authentication and device identity
- Access JWT issuer, audience, expiry, signature and algorithm validation.
- Device P-256 proof-of-possession canonicalization, timestamp tolerance and nonce replay rejection.
- Device enrolment, account isolation, revocation, heartbeat expiry and stale-device behavior.
- Cross-account, cross-device and revoked-device authorization attempts.

### 2. Memory and synchronization
- Ciphertext-only server/client persistence and plaintext leakage through logs, errors, caches or telemetry.
- Trust-state transitions: pending by default, explicit approval, rejection, tombstones and revision ordering.
- Cursor tampering, replay, pagination gaps and recovery after restore/rebuild.
- Idempotency under retries, duplicate submissions and concurrent revisions.
- Offline cache/outbox scope separation and local storage/XSS threat boundaries.

### 3. Tasks and concurrency
- Capability matching and authorization.
- Lease ownership, expiry, renewal, duplicate claim and concurrent completion.
- Replay, stale lease, cross-account access and race conditions.

### 4. Abuse and financial controls
- Rate-limit bypass across accounts/devices/IPs and boundary conditions.
- Provider budget reservation/settlement concurrency, retries, timeout, malformed usage and settlement-over-reservation behavior.
- Voice upload limits, request replay and billable retry semantics.
- Confirm all staging provider spend/token/voice caps remain zero unless separately approved for a controlled sandbox test.

### 5. Browser and Android clients
- Browser XSS, CSP, Trusted Types, token handling, service-worker update path and IndexedDB CryptoKey handling.
- Android Keystore alias isolation, SQLite ciphertext-only queue, backup/restore exclusion, process death and replay.
- Cross-device sync, account switching, logout/revocation and offline-device residual access.

### 6. Cloud operations and recovery
- Cloudflare Access policy correctness and Worker origin exposure.
- D1 migration safety, export integrity, restore to a fresh database and account isolation after restore.
- Worker version rollback without assuming schema rollback.
- Secret exposure, debug endpoints, deployment configuration and audit evidence.

## Required deliverables

1. Written methodology, exact scope and test environment.
2. Executive summary and severity-ranked findings.
3. Reproduction steps, affected endpoints/components and evidence for every finding.
4. False-positive rationale and explicit residual-risk register.
5. Remediation recommendations and retest results.
6. Confirmation that test data/resources were destroyed or transferred to the owner securely.

## Release gate

Do not promote NEO to production until all critical/high findings are remediated or formally risk-accepted by the owner, the assessor has retested the fixes, and the staging migration/rollback/restore evidence is attached to the release record.
