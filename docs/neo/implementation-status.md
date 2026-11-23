# NEO implementation status

**As of:** 2026-11-23  
**Working branch:** neo/foundation-architecture  
**Pull request:** #1 — Draft, open, not merged  
**Deployment:** Not deployed. No Cloudflare resources, provider credentials, paid inference, DNS, or real devices have been activated.

This report separates source implementation from tested behavior and from production readiness.

## Implemented in source

| Area | State | What exists |
|---|---|---|
| Architecture | Documented | One account identity across authorised devices; cloud-first coordination; devices are clients/optional workers, not the permanent brain. |
| Memory trust model | Implemented in OpenJarvis | User-authored evidence, pending-by-default candidates, explicit approval/rejection, quarantine handling, and CLI flows. |
| Access and device security | Implemented | Access JWT RS256 signature, issuer, audience and expiry validation; P-256 device proof; timestamp window; nonce replay protection; device enrolment, listing, heartbeat, presence and revocation. |
| D1 schema | Eight ordered migrations | Account/device/memory/task/audit data; nonce records; task capabilities; API rate limits; monthly spend ledger; settlement guards; idempotency for memory/task writes; monthly input/output token budgets. |
| Encrypted memory API | Implemented | Client-encrypted immutable revisions, pending-by-default writes, approval into a new revision, tombstones, base64url wire serialization and opaque rowid sync cursor. |
| Offline replay safety | Implemented | Idempotency keys and request hashes for memory writes and task enqueue. Reusing a key with different content returns 409. |
| Task delegation | Implemented | Capability-aware claims, expiring leases, concurrent-claim protection, and lease expiry recovery when another device claims. |
| Device coordination | Implemented | Authenticated heartbeat and online/offline freshness indicator (90-second window); any authenticated request also refreshes last-seen time. |
| Provider spend controls | Implemented, fail-closed | Per-account monthly USD-micro cap; per-provider input/output pricing; prompt byte and per-request output-token ceilings; monthly input/output token caps; atomic D1 reservations and settlement triggers. |
| Voice spend controls | Implemented, fail-closed | Voice transcription/synthesis require a reviewed maximum per-request cost and share the monthly spend cap. |
| Model routing | Implemented | Primary/backup routing, explicit model no-fallback behavior, auto, allow_fallback=false, and provider/tier/fallback metadata. |
| Web client | Source implemented; TypeScript checked | Non-exportable P-256 key in IndexedDB; encrypted memory cache; durable ciphertext-only outbox; idempotent replay; manual flush; heartbeat; task and voice transport. |
| Android client | Starter source implemented; not built on Android CI | Android Keystore P-256 identity; SQLite ciphertext-only cache/outbox; idempotent replay; heartbeat; signed requests and voice transport. |
| API contract | Draft OpenAPI 3.1 | Device, memory, task, chat and voice routes; still needs automated contract linting. |

## Verification evidence

Latest NEO Worker run at the time of this report:

- Workflow run #53: **Success**
- Tested commit: 0e2ba33f2da377d264fc7ae0aa13cd82e13123ce
- npm install --ignore-scripts: passed; npm reported 0 vulnerabilities.
- npm run check: passed.
- npm test: passed.
- Vitest: **2 test files, 39 tests passed**.

D1-backed integration coverage includes:
- Valid/invalid Access JWT signature, issuer, audience and expiry.
- Device signature, nonce replay, cross-account isolation, enrolment and revocation.
- Device online/offline presence and heartbeat.
- D1 rate limiting.
- Concurrent memory revision allocation and memory idempotency.
- Task idempotency, capability filtering, competing leases and expired-lease recovery.
- Concurrent monthly spend reservations and settlement bounds.
- Concurrent monthly output-token reservations and token settlement bounds.
- Primary-to-backup failover, explicit-model no-fallback, allow_fallback=false, spend exhaustion and provider network failure.
- Voice transcription and speech synthesis proxy behavior.

These tests run against Cloudflare's local Workers runtime and SQLite-backed D1 simulation. They are not a remote D1 staging test or a production penetration test.

## Financial controls — important operating rule

The non-test Wrangler defaults are deliberately set to zero for:
- MAX_MONTHLY_SPEND_USD_MICROS
- MAX_MONTHLY_INPUT_TOKENS
- MAX_MONTHLY_OUTPUT_TOKENS
- all primary/backup input/output model prices
- voice transcription/synthesis maximum per-request costs

Therefore **chat and voice inference remain blocked** until a provider/model is selected, current provider pricing is independently checked, and the owner explicitly sets a monthly USD spend cap, input-token cap, output-token cap, and voice per-request ceilings. No provider secrets have been added.

Input-token reservation uses serialized request bytes as a conservative upper bound; output tokens are bounded by the server maximum. Every possible provider candidate is reserved before a request. Failed attempts are charged their full reservation; missing usage data is charged conservatively at the reservation. A settlement above the reservation is rejected and leaves the reservation held, intentionally blocking additional inference until an operator reconciles it. Automated reservation-reconciliation tooling is not yet implemented.

## Remaining blockers

1. **Staging and operational validation:** No Cloudflare account resources have been provisioned; remote D1 migration rehearsal, staging deployment, rollback, restore and deletion tests remain.
2. **Real provider compatibility:** All provider/voice integration tests use mocks. Test real provider error formats, timeouts, malformed/missing usage, voice duration pricing and backup independence after credentials and budget are approved.
3. **Budget operations:** Pricing is manually configured and can drift. Add a documented pricing review/update process, budget dashboard/alerts, reservation reconciliation and operator audit trail. Current caps are per account, not a global shared-provider-key ceiling.
4. **Offline behavior:** Web/Android cache and outbox are source implemented, but browser IndexedDB and Android SQLite behavior have not been exercised on real devices. Outbox flush is caller-driven; no automatic background scheduler/backoff exists.
5. **Local inference fallback:** Not implemented. Offline mode currently provides encrypted cached memory and queued writes/tasks, not an equivalent local AI model.
6. **Browser security:** Add strict CSP, dependency/XSS controls, secure Access-token lifecycle, persistence/recovery tests and device re-enrolment flow.
7. **Native app integration:** Android code is a transport/storage primitive, not a built application. No Gradle app/test project, Access login UI, microphone permission UX, background worker or real-device test exists. iOS and desktop integrations are absent.
8. **Storage/coordination expansion:** R2 encrypted attachments/exports/snapshots and Durable Object coordination are not implemented or provisioned.
9. **Independent security review:** Source-level checks are not a third-party penetration test or security certification.
10. **Language quality gate:** Run the Hindi/Hinglish evaluation set across candidate models, blind-score outputs, and select no primary model until quality and cost gates pass.

## Release decision

Keep PR #1 as **Draft**. Do not merge or deploy yet. The Worker foundation now has meaningful local D1 security/concurrency coverage and fail-closed spend/token controls, but staging, real provider testing, Android device validation, browser hardening, recovery operations and independent security review remain release blockers.
