# NEO Cloudflare infrastructure scaffold

This directory contains the D1 schema, API contract, Worker source, and starter web/Android device clients. The Worker and browser Alpha have been deployed to the disposable staging environment; the remote D1 schema has not yet been migrated or verified.

## Contract and resources

See openapi.yaml for the v0 device, encrypted-memory, task-lease, chat-routing and voice API.

Intended resources:
- Workers for authenticated API gateway, policy checks, model routing and provider adapters.
- D1 for accounts, devices, encrypted memory revisions, task leases, audit records, rate limits, idempotency and spend/token ledgers. A 15-minute Worker cron removes expired device nonces; settled spend records are retained for audit.
- R2 for client-encrypted attachments, exports and snapshots (not yet implemented).
- Durable Objects for per-account ordering, device/task coordination and presence (not yet implemented).
- Google OpenID Connect for owner identity on browser and Android; the Worker verifies Google ID-token signatures and claims against Google's published signing keys. Cloudflare Access remains a temporary, independently verified migration fallback only.

## Staging resource status

A dedicated Cloudflare D1 database has been created for NEO staging. The Worker deployment is verified, but the remote database migration state and authenticated data paths remain unverified:
- Database name: `neo-staging-db`
- Database ID: `dd4c03d6-a286-4ac9-abbc-8f162b692acc`

The disposable Wrangler template `wrangler.disposable.example.toml` is bound to this database. Do not create tables manually; apply the checked-in migrations in order after authentication and deployment prerequisites are satisfied.

## Before deployment

1. Confirm the account's billing posture; do not enter payment details or start a paid Zero Trust plan just to unblock this project.
2. Review the Google OIDC sign-in flow and its token lifecycle. The Worker currently verifies Google ID-token signatures and claims for session bootstrap and first-device enrolment, then requires a device signature for subsequent API requests. First-device enrolment now requires a server-issued, ten-minute, one-time nonce challenge, stored as a hash and consumed atomically. This new flow is awaiting CI verification and remote staging verification; do not treat it as production-ready yet. Cloudflare Access JWT verification is an optional migration fallback, not a requirement for the Google flow.
3. Keep Cloudflare Access issuer/audience unset unless the optional Access fallback is deliberately configured and reviewed. Never deploy with placeholder identity configuration.
4. Decide account identity, recovery and deletion behavior.
5. Review `D1_STAGING_RUNBOOK.md`, verify the exact disposable D1 binding, capture a pre-migration Time Travel bookmark and SQL export, and obtain explicit approval before applying migrations 0001–0010 interactively. Never use an account-wide D1 Edit token.
6. Configure optional Access and provider secrets only through Wrangler/Cloudflare secret storage.
7. Keep provider credentials unset until provider selection, current pricing, monthly USD cap, input/output token caps and voice per-request ceilings are explicitly approved.
8. Deploy only to disposable staging after migration, authentication, rollback and recovery tests pass. Do not create R2 or Durable Objects for the first Alpha unless a tested feature requires them.

## Data protection rules

- Store only client-encrypted memory/task payloads in D1. Keep nonce and key version with each ciphertext.
- The web and Android offline queues accept encrypted payload bodies only; do not enqueue plaintext conversation data.
- Never put Access tokens, provider API keys, private device keys or memory encryption keys in D1, R2 or Git.
- Encrypt attachments before R2 upload; use opaque object keys.
- Memory revisions are immutable. Deletion uses tombstones; propagate tombstones to caches and replicas.
- D1 is durable truth. Durable Object state must be reconstructible.

## Spend and token controls

The Worker reserves per-account monthly USD-micro spend plus monthly input/output tokens before any chat provider request. It reserves the worst-case cost/tokens for every provider candidate that may be attempted. Failed attempts are charged conservatively; missing usage is settled at the reservation. Voice requests require a maximum per-request cost ceiling and share the monthly spend budget.

All non-test defaults for budgets, model pricing and voice ceilings are zero. This deliberately blocks paid inference until the owner configures reviewed values. Pricing is manual and must be checked against the chosen provider/model before enabling.

## Not yet complete

A Wrangler deployment dry-run against the test configuration passes in CI, but no Cloudflare resources are provisioned. R2, Durable Object coordination, automated spend-reservation reconciliation, budget alerts, local model inference fallback, background outbox retry scheduling, remote D1 staging tests, rollback/restore rehearsal and independent penetration testing remain outstanding.

## Google OIDC authentication implementation status

The Worker now supports Google ID-token verification for session bootstrap, first device enrolment and subsequent signed requests. It validates RS256 signatures against Google's fixed JWKS endpoint, issuer, configured audience, expiry and issued-at time, and namespaces accounts as `google:<sub>`. The browser Alpha now uses Google Identity Services and passes the ID token to the Worker. The Android transport accepts an identity-token callback and exposes `resolveAccountScope`; the installable Android diagnostic harness now uses Google Credential Manager, resolves the Google account scope, enrols its P-256 device key and sends a heartbeat to staging. Build it with `-PgoogleWebClientId=<Google Web OAuth client ID>` and `-PneoApiBaseUrl=<HTTPS disposable staging origin>`. This proves the diagnostic client path, not a production Android assistant UI. A configured OAuth client ID and a real staging deployment are still required for end-to-end device login. Cloudflare Access JWT verification remains available only as a migration fallback while older tests and clients transition.

## Disposable staging deployment workflow

The GitHub Actions workflow `.github/workflows/neo-disposable-staging.yml` builds the browser app, deploys only `neo-api-disposable-staging`, and checks its `/v1/health` endpoint. It does **not** apply D1 migrations. Migration application is a separate, manually approved operation described in `D1_STAGING_RUNBOOK.md`. Before using it, configure these GitHub Actions values:

- Secret `CLOUDFLARE_API_TOKEN`: an account-scoped API token; never paste it into chat or commit it.
- Variables `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, and `NEO_GOOGLE_WEB_CLIENT_ID`.

The token needs Account `D1:Edit`, Workers permission sufficient to deploy the existing Worker (prefer Editor scoped to `neo-api-disposable-staging`; creating a new Worker requires Workers Admin), and Account Settings Read if Wrangler requires it. Do not grant Zero Trust permissions, billing permissions, DNS permissions, or access to unrelated projects. If the Worker does not yet exist, create only the named disposable Worker first, then scope the token to that Worker. The workflow does not configure model-provider secrets; inference remains disabled by zero spend/token limits.
