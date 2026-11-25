# NEO Cloudflare Worker

This is the executable NEO API gateway implementation. A previous Worker version is deployed to the disposable staging Worker; the latest branch code is not yet deployed. The remote D1 schema and authenticated data paths are not yet verified, so it is **not production-ready**.

## Implemented routes and controls

- Google OIDC ID-token verification (RS256, issuer, audience, expiry) for browser/native identity bootstrap and first-device enrolment; optional Cloudflare Access JWT fallback; account/device binding.
- Google first-device enrolment now requires a server-issued, ten-minute, one-time nonce challenge; the Worker stores only the challenge hash, rate-limits challenge creation and atomically consumes it. Subsequent API calls require the enrolled P-256 device signature and request nonce.
- First-device and additional-device enrolment using a client-generated P-256 public key.
- Signed device requests with a five-minute timestamp window and one-use nonce replay protection.
- Device listing, online freshness indicator, authenticated heartbeat and immediate revocation; scheduled cleanup removes expired nonce replay records every 15 minutes.
- Client-encrypted memory create/sync, pending-by-default trust, explicit approval into a new immutable revision, tombstones and opaque rowid cursor.
- Memory-write and task-enqueue idempotency keys with request hashes; key reuse with different content returns 409.
- Encrypted task enqueue, capability-aware claims, expiring leases, concurrent claim protection and recovery after lease expiry.
- JSON body limits (default 1 MB, hard maximum 5 MB) and voice body limit (15 MB).
- D1 fixed-window account rate limit (default 60/minute, configurable up to 600).
- Primary/backup OpenAI-compatible chat routing, explicit-model no-fallback, auto, allow_fallback=false and route metadata.
- Authenticated voice transcription and speech synthesis proxy.

## Provider spend and token budget

Before a chat request, the Worker reserves:
- worst-case USD micro-cost using configured per-provider input/output rates;
- a conservative input-token upper bound derived from serialized request bytes;
- requested output-token maximum, capped by MAX_OUTPUT_TOKENS.

It reserves the maximum for every provider candidate that may be attempted. Failed attempts are charged their full reservation. If usage is absent, the reservation is charged conservatively. D1 triggers reject reservation or settlement above configured monthly monetary/input/output token caps. A settlement above its reservation fails closed and leaves the reservation held for operator reconciliation.

Voice requests require VOICE_TRANSCRIBE_MAX_COST_USD_MICROS or VOICE_SYNTHESIS_MAX_COST_USD_MICROS and share the monthly spend cap. These must represent a conservative maximum cost for the accepted request size/duration.

**Fail-closed defaults:** In the non-test wrangler.toml, monthly USD spend, monthly input/output token limits, model prices and voice per-request ceilings are all zero. Paid inference remains blocked until provider/model selection, current pricing review and owner-approved budgets are configured. Do not add provider secrets before approval.

## Local validation

Run npm install, Redocly OpenAPI lint, npm run check, npm run deploy:dry-run and npm test.

Vitest runs in the Cloudflare Workers runtime with local SQLite-backed D1 and applies migrations 0001–0010. Verified code run #229 passed 70 Worker tests and 9/9 Playwright browser persistence tests. On the current branch head, Redocly OpenAPI lint, TypeScript check, Wrangler deploy dry-run and all 70 Worker tests have passed; the fresh Playwright matrix is still running. Local integration evidence is not remote D1 or staging proof.

## Offline clients

- Web client: non-exportable P-256 identity in IndexedDB, account-scoped encrypted memory cache with tombstone-aware recall, durable ciphertext-only outbox, idempotent memory/task replay, and caller-driven flushOutbox().
- Android client: Android Keystore P-256 identity and account-scoped SQLite ciphertext-only memory cache/outbox with idempotent replay.
- Both expose heartbeat calls. The host application must schedule heartbeat and outbox flush when connected.
- Offline mode currently supports encrypted cached memory and queued writes/tasks; **local model inference fallback is not implemented**.

The Android transport/storage primitive and a diagnostic Gradle harness now exist. CI covers Android unit tests and emulator instrumentation; this is not yet a finished consumer Android assistant UI, and no physical-device validation has been performed.

## Staging checklist

1. Verify the Google Web OAuth client ID, allowed audience and test-user configuration. Cloudflare Access is an optional fallback, not a prerequisite for Google sign-in.
2. Confirm the existing disposable D1 identity is exactly `neo-staging-db` / `dd4c03d6-a286-4ac9-abbc-8f162b692acc`.
3. Create a separate Developer Platform Editor token scoped only to that D1 resource. Follow `../D1_STAGING_RUNBOOK.md`; run preflight first, then apply migrations 0001–0010 only after explicit owner approval.
4. Verify the remote migration list, tables, indexes and triggers. Keep scheduled maintenance disabled until schema verification is complete.
5. Deploy the latest Worker/browser assets to disposable staging using the separate Worker-only deployment token. Test Google sign-in, one-time challenge/replay rejection, device enrolment, authenticated APIs and revocation.
6. Keep provider secrets unset and budgets at zero until a provider/model, current pricing and hard monthly/input/output limits are explicitly approved.
7. After approval, test real provider usage, failover and settlement with the hard caps enabled.
8. Test browser/Android device pairing, encrypted memory synchronisation, offline recovery and physical-device behavior. Production remains out of scope.

Never commit API keys, Access tokens, private device keys or memory encryption keys.
