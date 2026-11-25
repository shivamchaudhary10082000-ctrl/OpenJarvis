# PostgreSQL port inventory (derived from the current Worker and D1 migrations)

This is an engineering inventory, not a claim that a port exists. The Worker remains D1-backed.

## Compatibility points observed

- Worker environment contract currently declares `DB: D1Database`; most route handlers use D1 prepared statements directly. There is no clean database adapter seam yet.
- Identity/account creation and device enrollment/authentication touch accounts, devices, account status, device signature replay nonces, account rate-limit windows, and device last-seen timestamps.
- Memory sync uses append-only revisions, latest-revision queries, conditional revision writes, trust-state transitions, tombstones, and an opaque cursor derived from D1's implicit rowid/insertion sequence. PostgreSQL needs an explicit monotonically increasing cursor (sequence/identity) and cursor encoding compatibility.
- Task queue writes use account-scoped idempotency and request hashes. Claiming tasks uses expired-lease recovery, capability matching via SQLite `json_each`, then a conditional queued-to-leased update. PostgreSQL should make claim + lease assignment one atomic statement/transaction and replace JSON capability expansion with supported Postgres operators.
- Spend budget accounting uses D1 triggers to atomically hold USD and token ceilings, settle/release reservations, and prevent settled usage exceeding monthly caps. A Postgres port needs transaction/locking logic or equivalent triggers/functions, tested for races; do not rely on multiple independent REST calls.
- OIDC challenge nonce consumption is one-time and expiry-bound. D1 also enforces issuance throttling with a trigger. Challenge and rate-limit behavior must remain atomic.
- Scheduled Worker cleanup removes expired device nonces and conservatively settles stale provider reservations.

## Porting order and acceptance criteria

1. **Schema parity:** map every D1 migration (0001–0010) into Postgres types, keys, constraints, indexes and equivalent accounting behavior. Avoid adding schema objects to the user's existing physiotherapy project.
2. **Cursor compatibility:** explicitly replace `rowid` cursor semantics with a sequence/identity; prove same-second multi-write pagination cannot skip or duplicate entries.
3. **Transaction primitives:** implement tested Postgres routines for memory revision/idempotency, task claim/lease recovery, budget reserve/settle/reconcile, challenge consume/rate limit, account rate limit and nonce replay protection.
4. **Worker seam:** create a database interface at route boundaries; keep D1 implementation working while tests establish parity. Avoid wholesale search-and-replace of D1 calls.
5. **Test harness:** use disposable Postgres with migration apply/reset; concurrency tests for reservations, revisions, task claims and replay; run all existing Worker tests against D1 adapter and new port tests against Postgres.
6. **Staging switch:** only after isolated project access and cost are approved, run migrations on the separate NEO project, configure Worker secrets, deploy disposable staging, and test end-to-end. Retain D1 rollback path until acceptance.
7. **Safety:** no client-facing database credentials; private schema, minimal privileges, RLS/role review, advisor checks; zero spend/token budgets by default; no live provider until explicitly budgeted.

## Current known mismatch in the draft

The Postgres draft adds an identity `sync_id` to memory records, but does not yet wire it into cursor APIs; this is deliberate scaffolding only. Existing D1 composite primary key semantics are preserved with a unique constraint. The draft lacks complete atomic routines/triggers and must not be applied as-is.

## Explicitly not done

- No remote D1 migration, deletion, or schema modification.
- No Supabase project created, no schema applied, no secrets exchanged.
- No Worker DB adapter or Postgres-backed route implementation.
- No deployment, PR merge, production action, or provider spending.
