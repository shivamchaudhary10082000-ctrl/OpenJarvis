# NEO disposable D1 staging migration runbook

This runbook is for the dedicated disposable database only:

- Database: `neo-staging-db`
- Database ID: `dd4c03d6-a286-4ac9-abbc-8f162b692acc`
- Worker: `neo-api-disposable-staging`

Never use these commands with a production database or a different Wrangler configuration.

## Current migration set

Migrations are ordered in `infra/cloudflare/migrations/`:

1. `0001_neo_core.sql`
2. `0002_device_request_nonces.sql`
3. `0003_task_capabilities.sql`
4. `0004_api_rate_limits.sql`
5. `0005_provider_spend_limits.sql`
6. `0006_provider_spend_settlement_guard.sql`
7. `0007_offline_idempotency.sql`
8. `0008_provider_token_budgets.sql`
9. `0009_enforce_settled_token_budgets.sql`
10. `0010_oidc_login_challenges.sql`

Migration 0009 fixes a correctness gap in 0008: token reservation checks must count both settled usage and currently reserved usage against each monthly cap. Migration 0010 adds hashed, short-lived, one-time OIDC nonce challenges used to protect first-device enrollment from ID-token replay.

## Required preflight

Run from `infra/cloudflare/worker` using the pinned Wrangler dependency:

1. Verify the active branch and review the exact migration files being applied.
2. Inspect `../wrangler.disposable.toml` and verify the Worker name, database name and database UUID above. Stop if any value differs.
3. Query database identity and status:

   ```sh
   npx wrangler d1 info neo-staging-db --json
   ```

4. Capture the current Time Travel bookmark and save it outside the repository:

   ```sh
   npx wrangler d1 time-travel info neo-staging-db --json
   ```

5. Export a SQL backup to a private, access-controlled location outside Git and CI artifacts:

   ```sh
   npx wrangler d1 export neo-staging-db --remote --output=/secure/path/neo-staging-pre-migration.sql
   ```

   Treat this export as sensitive data. Cloudflare documents that D1 export requires D1 Write permission because export locks the database while it runs.

6. List the remote migration state:

   ```sh
   npx wrangler d1 migrations list neo-staging-db --remote --config ../wrangler.disposable.toml
   ```

7. Confirm the database is the disposable target, inspect the unapplied migration list, and obtain explicit owner approval before applying.

## Apply

Only after the preflight, backup and explicit owner approval:

```sh
npx wrangler d1 migrations apply neo-staging-db --remote --config ../wrangler.disposable.toml
```

Run this interactively from a controlled workstation. Do not place a broad D1 credential in GitHub Actions and do not rely on a non-interactive workflow for the first migration. Wrangler prompts for confirmation interactively; in CI the confirmation is skipped. Cloudflare states that a backup is captured after migrations apply and a failed migration is rolled back, leaving the previous successful migration applied.

Immediately afterwards, list migrations again and run read-only schema checks for the expected tables, columns, indexes and triggers. Then run authenticated integration smoke tests against staging.

## Permission decision

Prefer an account-owned API token with D1 Editor scoped to the single `neo-staging-db` resource, if the Cloudflare token/Developer Platform permission UI explicitly offers that exact resource scope. The UI must identify this database by name or UUID; a generic D1 Edit permission scoped to the entire account or all D1 databases is not acceptable for this project.

If the available UI only offers account-wide or product-wide D1 Edit, stop. Do not create that token. The safe fallback is to isolate NEO staging in a separate Cloudflare account containing no production databases, then issue the migration credential only within that isolated account. Do not substitute a global API key, an administrator token, or the existing Worker-only deployment token.

## Recovery

D1 Time Travel is automatically enabled. Record the pre-migration bookmark from the preflight. It is the preferred point-in-time recovery mechanism for the short retention window on the current plan. Cloudflare documents seven days of history on Workers Free and 30 days on Workers Paid.

A Time Travel restore overwrites the database in place and cancels in-flight queries. It is destructive. Do not restore automatically on a migration error. First inspect the migration state and error; failed migrations should be rolled back by Wrangler. Restore only after an explicit recovery decision, using the exact saved bookmark and a second confirmation:

```sh
npx wrangler d1 time-travel restore neo-staging-db --bookmark="<SAVED_PRE_MIGRATION_BOOKMARK>"
```

Keep the separate SQL export for longer-term recovery; Time Travel retention is limited. Verify the restored schema and migration tracking table before redeploying or retrying.

## Deployment separation

The current `.github/workflows/neo-disposable-staging.yml` workflow builds the browser assets, deploys only the disposable Worker and checks `/v1/health`. It does **not** apply D1 migrations. Keep migration application as a separate, manually approved operation. Health success alone does not prove database readiness.
