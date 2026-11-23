# NEO Cloudflare infrastructure scaffold

This directory contains the D1 schema, API contract, Worker source, and starter web/Android device clients. The Worker has a local integration test suite but has **not** been deployed or connected to a Cloudflare account.

## Contract and resources

See openapi.yaml for the v0 device, encrypted-memory, task-lease, chat-routing and voice API.

Intended resources:
- Workers for authenticated API gateway, policy checks, model routing and provider adapters.
- D1 for accounts, devices, encrypted memory revisions, task leases, audit records, rate limits, idempotency and spend/token ledgers.
- R2 for client-encrypted attachments, exports and snapshots (not yet implemented).
- Durable Objects for per-account ordering, device/task coordination and presence (not yet implemented).
- Cloudflare Access for user identity; the Worker verifies the Access JWT itself.

## Before provisioning

1. Confirm the Cloudflare account and billing plan.
2. Create a Cloudflare Access application and record its audience tag and team issuer domain.
3. Decide account identity, recovery and deletion behavior.
4. Create D1/R2/Durable Object resources in staging first.
5. Apply migrations 0001_neo_core.sql through 0008_provider_token_budgets.sql in order.
6. Configure Access and provider secrets only through Wrangler/Cloudflare secret storage.
7. Keep provider credentials unset until provider selection, current pricing, monthly USD cap, input/output token caps and voice per-request ceilings are approved.
8. Deploy only to staging after migration, authentication, rollback and recovery tests pass.

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

No Cloudflare resources are provisioned. R2, Durable Object coordination, automated spend-reservation reconciliation, budget alerts, local model inference fallback, background outbox retry scheduling, remote D1 staging tests, rollback/restore rehearsal and independent penetration testing remain outstanding.
