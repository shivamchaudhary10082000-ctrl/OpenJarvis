# NEO Cloudflare Worker

This is the executable NEO API gateway implementation. It is deployed only to the disposable staging Worker; the remote D1 schema and authenticated data paths are not yet verified, so it is **not production-ready**.

## Implemented routes and controls

- Google OIDC ID-token verification (RS256, issuer, audience, expiry) for browser/native identity bootstrap and first-device enrolment; optional Cloudflare Access JWT fallback; account/device binding.
- Important auth limitation: Google ID tokens are not yet bound to a server-issued one-time nonce/challenge. Complete challenge/replay hardening before treating first-device enrollment as production-safe.
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

Vitest runs in the Cloudflare Workers runtime with local SQLite-backed D1 and applies the checked-in migrations 0001–0009. Latest pre-fix verified run #208 passed 66 Worker tests and the native browser persistence matrix 9/9; the cumulative token-budget regression in migration 0009 is awaiting fresh CI verification. Local integration evidence is not remote D1 or staging proof.

## Offline clients

- Web client: non-exportable P-256 identity in IndexedDB, account-scoped encrypted memory cache with tombstone-aware recall, durable ciphertext-only outbox, idempotent memory/task replay, and caller-driven flushOutbox().
- Android client: Android Keystore P-256 identity and account-scoped SQLite ciphertext-only memory cache/outbox with idempotent replay.
- Both expose heartbeat calls. The host application must schedule heartbeat and outbox flush when connected.
- Offline mode currently supports encrypted cached memory and queued writes/tasks; **local model inference fallback is not implemented**.

The Android transport/storage primitive and a diagnostic Gradle harness now exist. CI covers Android unit tests and emulator instrumentation; this is not yet a finished consumer Android assistant UI, and no physical-device validation has been performed.

## Staging checklist

1. Create Cloudflare Access application; set team issuer domain and audience.
2. Create staging D1 and replace the placeholder database ID.
3. Review `../D1_STAGING_RUNBOOK.md`; apply migrations 0001–0009 only after a verified backup and explicit owner approval; verify the migration list.
4. Keep provider secrets unset initially. Verify auth, revocation, memory, task and rate-limit flows.
5. Configure a low owner-approved spend/token cap and reviewed provider prices only after choosing a provider/model.
6. Test real provider failover and voice billing with sandbox credentials and hard caps.
7. Rehearse rollback, backup/restore, deletion propagation and reservation reconciliation.
8. Deploy to staging only after those gates; production remains out of scope.

Never commit API keys, Access tokens, private device keys or memory encryption keys.
