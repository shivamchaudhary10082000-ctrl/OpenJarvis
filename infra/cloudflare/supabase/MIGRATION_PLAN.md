# Supabase migration exploration (staging only)

## Why
The current Cloudflare Worker is deeply coupled to D1's `prepare().bind().first/all/run/batch`, SQLite triggers, `json_each`, `rowid`, and `MAX()`-based revision allocation. Supabase PostgreSQL is not a drop-in D1 endpoint. Simply changing the binding would break request handlers and accounting guarantees.

## Proposed low-complexity architecture
- Keep the existing Cloudflare Worker as the API gateway, Google identity verifier, device signature verifier and model router.
- Replace D1 with a dedicated Supabase PostgreSQL project only after cost and org approval.
- Prefer a single Worker-only database access path. Browser and Android never receive a database password, service-role key, or direct write permissions.
- Store encrypted memory/task ciphertext and opaque device identifiers only.
- PostgreSQL schema is drafted in `supabase/001_neo_schema_draft.sql`; it is not applied and not yet considered production migration-ready.

## Port risks and implementation plan
1. Port all tables and columns, preserve FK/cascade behavior and ciphertext-only constraints.
2. Replace D1 query calls using a small typed database adapter or PostgreSQL RPCs. Avoid ad-hoc SQL REST substitutions.
3. Preserve atomic task leasing and stale-lease recovery using row locks / conditional updates.
4. Preserve memory revision allocation and idempotency with transaction isolation, unique constraints, and conflict retry.
5. Port spend reservations/settlement into transaction-safe database routines. Validate settled USD and token counts against reservation and monthly limits. Keep default limits zero.
6. Port nonce consumption, challenge rate limits, device request replay protection, account rate limit, cleanup and audit.
7. Keep access to schema `neo` private and deny `anon`/ `authenticated`; Worker uses a server-only credential or vetted connection method.
8. Add Postgres-backed tests (budget concurrency, idempotency race, revision race, task lease race, challenge replay, rate-limit race, device revocation).
9. Verify Supabase security/performance advisors and API exposure before staging.
10. Deploy to disposable staging only after a separate project is created and verified; never migrate existing DrShivamPT data or touch production.

## Migration boundary
- No existing Supabase project schema or data was changed.
- No D1 remote migrations or staging deploy were performed.
- Creating a new Supabase project may incur cost; wait for a cost quote and explicit confirmation.
- Draft schema is not an approved executable migration; functions/triggers enforcing budgets and concurrency still need implementation and tests.
