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
| Device coordination | Implemented | Authenticated heartbeat and online/offline freshness indicator (90-second window); any authenticated request also refreshes last-seen time. Expired device nonces are removed by a 15-minute scheduled Worker cleanup. |
| Provider spend controls | Implemented, fail-closed | Per-account monthly USD-micro cap; per-provider input/output pricing; prompt byte and per-request output-token ceilings; monthly input/output token caps; atomic D1 reservations and settlement triggers. |
| Voice spend controls | Implemented, fail-closed | Voice transcription/synthesis require a reviewed maximum per-request cost and share the monthly spend cap. |
| Model routing | Implemented | Primary/backup routing, explicit model no-fallback behavior, auto, allow_fallback=false, and provider/tier/fallback metadata. |
| Web client | Source implemented; Worker CI tested with fake IndexedDB | Per-account non-exportable P-256 key in IndexedDB; account-scoped encrypted memory cache; durable ciphertext-only outbox; idempotent replay; manual flush; heartbeat; task and voice transport. Automated persistence/reconstruction/replay tests pass using fake IndexedDB; native browser matrix remains outstanding. |
| Android client | Starter source implemented; not built on Android CI | Per-account Android Keystore P-256 identity; account-scoped SQLite ciphertext-only cache/outbox; idempotent replay; heartbeat; signed requests and voice transport. Fixed outbox success counter; no Gradle harness or physical-device run exists. |
| API contract | Draft OpenAPI 3.1 | Device, memory, task, chat and voice routes; Redocly lint passes in CI. |

## Verification evidence

Latest NEO Worker run:
- Workflow run #106: **Success**
- Tested commit: `9e2d2fd4783cfc77c3cdc3cea9e3eed664e71922`
- npm install: passed.
- Redocly OpenAPI lint: passed.
- TypeScript check: passed.
- Wrangler deploy dry-run: passed.
- Vitest: **3 test files, 48 tests passed** (17 unit/route tests, 28 D1-backed integration tests, 3 browser-storage tests).

New coverage:
- Browser IndexedDB identity reconstruction, account-scope isolation, encrypted cache recovery after simulated offline restart, and durable ciphertext outbox replay.
- Heartbeat expiry after the 90-second freshness window and recovery to online after a new heartbeat.
- Voice upstream timeout accounting: maximum request reservation settled once; no blind retry of a billable audio upload.
- Android outbox replay success counter corrected.

Important qualification: browser persistence tests use fake IndexedDB with a test-only CryptoKey structured-clone adapter because Node's WebCrypto CryptoKey is not cloneable in that test runtime. This is not a real Chrome/Firefox/Safari test. Android code has not been compiled or exercised on physical devices.

These tests run against Cloudflare's local Workers runtime and SQLite-backed D1 simulation. They are not remote D1 staging tests or a production penetration test.

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

1. **Staging and operational validation:** A fail-closed disposable Wrangler template and staging/rollback/restore runbook are prepared. No Cloudflare resources have been provisioned; remote D1 migration rehearsal, staging deployment, rollback, restore and deletion tests remain.
2. **Real provider compatibility:** All provider/voice integration tests use mocks. Test real provider error formats, timeouts, malformed/missing usage, voice duration pricing and backup independence after credentials and budget are approved.
3. **Budget operations:** Pricing is manually configured and can drift. Add a documented pricing review/update process, budget dashboard/alerts, reservation reconciliation and operator audit trail. Current caps are per account, not a global shared-provider-key ceiling.
4. **Offline behavior:** Web IndexedDB persistence/reconstruction/outbox tests pass under fake IndexedDB; native browser testing remains. Android SQLite remains uncompiled and untested on physical devices; a manual two-device/offline/reboot/replay test plan is documented. Server-side revocation cannot remotely wipe a disconnected device or revoke its local memory-decryption key. Outbox flush is caller-driven; no automatic background scheduler/backoff exists.
5. **Local inference fallback:** Not implemented. Offline mode currently provides encrypted cached memory and queued writes/tasks, not an equivalent local AI model.
6. **Browser security:** Hosting CSP is not deployed. A report-only-to-enforce CSP, Trusted Types, XSS, dependency, token lifecycle and recovery review plan is documented; actual frontend origin/headers and token callback must be inspected before enforcement.
7. **Native app integration:** Android code is a transport/storage primitive, not a built application. No Gradle app/test project, Access login UI, microphone permission UX, background worker or real-device test exists. iOS and desktop integrations are absent.
8. **Storage/coordination expansion:** R2 encrypted attachments/exports/snapshots and Durable Object coordination are not implemented or provisioned.
9. **Independent security review:** Source-level checks are not a third-party penetration test or security certification.
11. **Desktop Rust dependency audit:** Current CI fails on `cookie 0.18.1` in `frontend/src-tauri/Cargo.lock` (RUSTSEC-2026-0594). The advisory documents a specific fork/thread condition; applicability to the Tauri process model needs review, but dependency upgrade to patched `cookie 0.18.3` and full re-verification are required. Do not ignore/suppress without documented justification.\n10. **Language quality gate:** Run the Hindi/Hinglish evaluation set across candidate models, blind-score outputs, and select no primary model until quality and cost gates pass.

## Release decision

Keep PR #1 as **Draft**. Do not merge or deploy yet. The Worker foundation now has meaningful local D1 security/concurrency coverage and fail-closed spend/token controls, but staging, real provider testing, Android device validation, browser hardening, recovery operations and independent security review remain release blockers.
