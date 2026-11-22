# NEO Cloudflare infrastructure scaffold

This directory is a schema baseline only. It is not connected to a Cloudflare account and must not be treated as a deployable service yet.

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
5. Apply `migrations/0001_neo_core.sql` to the staging D1 database.
6. Configure secrets through Wrangler/Cloudflare secret storage. Never commit Access credentials, model provider keys, signing keys, or encryption keys.
7. Deploy only a health-check build first. Add authenticated routes after JWT verification and device revocation tests pass.

## Data protection rules

- Store only client-encrypted memory payloads in D1. Keep nonce and key version alongside each ciphertext.
- Never put raw chat transcripts, provider API keys, or private device keys in D1 or R2.
- R2 objects must be encrypted before upload; use opaque object keys that do not reveal user names or content.
- D1 rows are versioned. Do not overwrite a prior approved revision in place; write a new revision and preserve deletion tombstones until all device replicas have acknowledged them.
- Use D1 for durable truth. Durable Object in-memory state is a coordination cache and must be reconstructible.

## Not yet implemented

Worker request handlers, Access JWT/JWKS verification, account/device enrolment, device proof-of-possession, D1 repositories, R2 upload/download, Durable Object coordination, provider adapters, rate limiting, and deployment configuration still need code and tests. No production resource has been created.
