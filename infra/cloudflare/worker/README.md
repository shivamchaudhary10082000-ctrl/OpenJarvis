# NEO Cloudflare Worker

This directory contains the first executable NEO API gateway implementation. It is source code and local tests, **not a deployed or production-ready service**.

## Implemented routes

- Cloudflare Access JWT verification (RS256, issuer, audience, expiry) and per-account device binding.
- First-device enrolment using a client-generated P-256 public key.
- Signed device requests with a five-minute timestamp window and one-use nonce replay protection.
- Device listing, online freshness indicator, and revocation.
- Client-encrypted memory create, incremental sync cursor, explicit approval into a new immutable revision, and deletion tombstones.
- Encrypted task enqueue, idempotency, device claiming, expiring leases, retry after lease expiry, and task status.
- OpenAI-compatible primary/backup chat routing with explicit provider/model/tier/fallback metadata. Explicit model requests never silently fall back.
- Authenticated transcription and speech synthesis proxy routes.

## Local validation

```sh
npm install
npm run check
npm test
```

The tests currently cover the unauthenticated health route and rejection of protected requests without an Access token. D1-backed authentication, replay, account isolation, memory revision, task lease and provider failover integration tests are still required before production use.

## Configure staging

1. Create a Cloudflare Access application and set its issuer domain and audience in `wrangler.toml`.
2. Create a D1 database and replace the placeholder database ID.
3. Apply migrations in order:
   `wrangler d1 migrations apply neo-staging --remote`.
4. Set provider credentials using `wrangler secret put MODEL_PRIMARY_API_KEY` and, if approved, `MODEL_BACKUP_API_KEY`.
5. Configure provider base URLs and model IDs in Worker vars. Use independent providers for meaningful backup resilience.
6. Run `wrangler dev`, test with a dedicated staging Access account, and only then deploy to staging.

Do not add API keys, Access tokens, private device keys, or memory encryption keys to Git. Do not enable provider secrets until the user has approved the provider and monthly spend cap. Production deployment, paid inference, account creation, and real device enrolment are intentionally not performed by this change.

## Device clients

- Web: `../clients/web/neo-client.ts` uses IndexedDB to retain the device signing key and accepts an Access-token callback.
- Android: `../clients/android/NeoDeviceIdentity.kt` stores a non-exportable P-256 key in Android Keystore; `NeoAndroidClient.kt` provides signed API and voice transport. The host app must supply OkHttp 4.12+, Kotlin coroutines, microphone permission handling, and an Access-token callback.

The clients are integration primitives, not a published app. A human must complete the Access login/enrolment flow on each device and verify the same account identity before cross-device use.
