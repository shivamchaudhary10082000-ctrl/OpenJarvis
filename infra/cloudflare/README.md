# NEO Cloudflare infrastructure scaffold

This directory contains the D1 schema, API contract, Worker source, and starter web/Android device clients. The Worker is implemented but has not been deployed or connected to a Cloudflare account.

## Contract

See `openapi.yaml` for the draft device, encrypted-memory, task-lease, and chat-routing API. The contract now has Worker handlers and basic route tests. It is still an evolving v0 API; full D1 integration/security tests and staging validation remain required.

## Intended resources

- One Worker as the authenticated API gateway and model-routing control plane.
- One D1 database for account/device metadata, immutable encrypted memory revisions, task leases, and audit events.
- One R2 bucket for client-encrypted attachments, exports, and snapshots.
- One Durable Object namespace for per-account coordination and device/task presence.
- Cloudflare Access in front of the Worker, with JWT audience validation in the Worker itself.

## Before provisioning

1. Create or select the Cloudflare account and confirm the intended billing plan.
2. Create a Cloudflare Access application and record its audience tag and team issuer domain.
3. Decide the account identity source and test account deletion/recovery.
4. Create D1, R2, and Durable Object resources in a staging environment first.
5. Apply all ordered migrations (`0001_neo_core.sql` through `0004_api_rate_limits.sql`) to the staging D1 database.
6. Configure secrets through Wrangler/Cloudflare secret storage. Never commit Access credentials, model provider keys, signing keys, or encryption keys.
7. Deploy only a health-check build first. Add authenticated routes after JWT verification and device revocation tests pass.

## Data protection rules

- Store only client-encrypted memory payloads in D1. Keep nonce and key version alongside each ciphertext.
- Never put raw chat transcripts, provider API keys, or private device keys in D1 or R2.
- R2 objects must be encrypted before upload; use opaque object keys that do not reveal user names or content.
- D1 rows are versioned. Do not overwrite a prior approved revision in place; write a new revision and preserve deletion tombstones until all device replicas have acknowledged them.
- Use D1 for durable truth. Durable Object in-memory state is a coordination cache and must be reconstructible.

## Not yet implemented

No Cloudflare resources have been provisioned. R2 attachment storage, Durable Object coordination, a hard provider spend ceiling/token budget, full D1-backed integration tests, and deployment configuration remain outstanding. A fixed-window D1 per-account rate limiter is implemented in migration `0004_api_rate_limits.sql`; it still needs D1 integration testing. See worker/README.md for implementation and staging steps.
