# NEO Cloudflare Worker

This directory contains the first executable NEO API gateway implementation. It is source code and local tests, **not a deployed or production-ready service**.

## Implemented routes

- Cloudflare Access JWT verification (RS256, issuer, audience, expiry) and per-account device binding.
- First-device enrolment using a client-generated P-256 public key.
- Signed device requests with a five-minute timestamp window and one-use nonce replay protection.
- Device listing, online freshness indicator, and revocation.
- Client-encrypted memory create, incremental sync cursor, explicit approval into a new immutable revision, and deletion tombstones.
- Encrypted task enqueue, idempotency, capability-aware device claiming, expiring leases, retry after lease expiry, and task status.
- Streaming request-body limits: JSON payloads are bounded by `MAX_BODY_BYTES` (default 1 MB, hard maximum 5 MB); voice payloads are bounded at 15 MB.
- Durable per-account fixed-window API rate limiting (default 60 requests/minute; configurable with `MAX_REQUESTS_PER_MINUTE`, capped at 600).
- OpenAI-compatible primary/backup chat routing with explicit provider/model/tier/fallback metadata. Explicit model requests never silently fall back.
- Authenticated transcription and speech synthesis proxy routes.

## Local validation

```sh
npm install
npm run check
npm test
```

The Vitest suite now runs inside the Cloudflare Workers runtime with a local SQLite-backed D1 database and applies the ordered migrations. It exercises Access JWT signature/issuer/audience/expiry validation, device proof and nonce replay, cross-account isolation, revocation, account rate limits, concurrent memory revisions, capability-aware claims, task lease races/expiry, provider failover, monthly spend reservations, and voice upload forwarding. These tests still require a successful fresh CI run; they are not a substitute for staging or a production security review.

## Configure staging

1. Create a Cloudflare Access application and set its issuer domain and audience in `wrangler.toml`.
2. Create a D1 database and replace the placeholder database ID.
3. Apply migrations in order:
   `wrangler d1 migrations apply neo-staging --remote` (including migrations `0003_task_capabilities.sql` and `0004_api_rate_limits.sql`).
4. Set provider credentials using `wrangler secret put MODEL_PRIMARY_API_KEY` and, if approved, `MODEL_BACKUP_API_KEY`.
5. Configure provider base URLs and model IDs in Worker vars. Use independent providers for meaningful backup resilience.
6. Run `wrangler dev`, test with a dedicated staging Access account, and only then deploy to staging.

Do not add API keys, Access tokens, private device keys, or memory encryption keys to Git. Do not enable provider secrets until the user has approved the provider and monthly spend cap. Production deployment, paid inference, account creation, and real device enrolment are intentionally not performed by this change.

## Device clients

- Web: `../clients/web/neo-client.ts` uses IndexedDB to retain the device signing key and accepts an Access-token callback.
- Android: `../clients/android/NeoDeviceIdentity.kt` stores a non-exportable P-256 key in Android Keystore; `NeoAndroidClient.kt` provides signed API and voice transport. The host app must supply OkHttp 4.12+, Kotlin coroutines, microphone permission handling, and an Access-token callback.

The clients are integration primitives, not a published app. A human must complete the Access login/enrolment flow on each device and verify the same account identity before cross-device use.
