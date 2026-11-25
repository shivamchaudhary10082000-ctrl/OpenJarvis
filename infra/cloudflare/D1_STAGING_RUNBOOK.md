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

Run from `infra/cloudflare/worker` using the pinned Wrangler dependency.

First materialize the disposable-only config. The generated file is ignored by Git and must never be committed:

```sh
cp ../wrangler.disposable.example.toml ../wrangler.disposable.toml
export NEO_GOOGLE_WEB_CLIENT_ID="your public Google Web OAuth client ID"
node --input-type=module <<'NODE'
import fs from "node:fs";
const path = "../wrangler.disposable.toml";
const clientId = process.env.NEO_GOOGLE_WEB_CLIENT_ID;
if (!clientId?.endsWith(".apps.googleusercontent.com")) throw new Error("Invalid Google Web client ID");
const config = fs.readFileSync(path, "utf8").replaceAll("REPLACE-WITH-GOOGLE-WEB-CLIENT-ID", clientId);
if (config.includes("REPLACE-WITH-")) throw new Error("Unresolved placeholder");
fs.writeFileSync(path, config);
NODE
```

1. Verify the active branch and review the exact migration files being applied.
2. Inspect `../wrangler.disposable.toml` and verify the Worker name, database name and database UUID above. Stop if any value differs.
3. Query database identity and status:

   ```sh
   npx wrangler d1 info neo-staging-db --json --config ../wrangler.disposable.toml
   ```

4. Capture the current Time Travel bookmark and save it outside the repository:

   ```sh
   npx wrangler d1 time-travel info neo-staging-db --json --config ../wrangler.disposable.toml
   ```

5. Export a SQL backup to a private, access-controlled location outside Git and CI artifacts:

   ```sh
   npx wrangler d1 export neo-staging-db --remote --output=/secure/path/neo-staging-pre-migration.sql --config ../wrangler.disposable.toml
   ```

   Treat this export as sensitive data. Cloudflare documents that D1 export requires D1 Write permission because export locks the database while it runs.

6. List the remote migration state:

   ```sh
   npx wrangler d1 migrations list neo-staging-db --remote --config ../wrangler.disposable.toml
   ```

7. Confirm the database is the disposable target, inspect the unapplied migration list, and obtain explicit owner approval before applying.

## Mobile-friendly migration workflow

A push-triggered, approval-gated workflow is available at `.github/workflows/neo-d1-staging-migrations.yml`. It never deploys the Worker. The approval file is `infra/cloudflare/D1_MIGRATION_APPROVAL.txt`, initially set to `NO`.

1. Add `CLOUDFLARE_D1_MIGRATION_TOKEN` as a GitHub Actions secret. It must be a separate token with Developer Platform **Editor** role scoped to the single `neo-staging-db` D1 resource.
2. For preflight only, edit `D1_MIGRATION_APPROVAL.txt` to `PREFLIGHT_ONLY` and commit to `neo/foundation-architecture` with `[neo-d1-preflight]` in the commit message. This verifies database identity, records a Time Travel bookmark, exports a SQL backup and lists migration state; it does not change the schema.
3. Inspect the workflow summary, download and safely retain the private backup artifact (one-day retention), and review the pending migration list.
4. Only after explicit owner approval, edit the file to `APPLY_0001_0010` and commit to the same branch with `[neo-d1-apply]` in the commit message. That exact file value plus commit marker is the explicit apply authorization. It applies only the checked-in migrations 0001–0010 to the hard-coded staging database UUID, then verifies critical tables and triggers.
5. After successful migration, reset the approval file to `NO`, revoke the temporary D1 migration token and remove its GitHub secret. Keep the existing Worker-only deployment token separate.

The workflow only runs on the engineering branch when the approval file changes and the commit marker matches the file contents. Ordinary pushes, a default `NO` value, or a mismatched marker cannot apply migrations.

The workflow fails closed if the branch, migration file set, database UUID, config placeholders or expected schema objects do not match. The non-interactive Wrangler confirmation is skipped in CI, so the `apply_migrations` boolean is the explicit owner confirmation. Cloudflare captures a backup after migration application and rolls back a failed migration, leaving the previous successful migration applied.

## Manual CLI alternative

If using a controlled workstation instead, only after the preflight, backup and explicit owner approval:

```sh
npx wrangler d1 migrations apply neo-staging-db --remote --config ../wrangler.disposable.toml
```

Wrangler prompts for confirmation interactively. Immediately afterwards, list migrations again and run read-only schema checks for the expected tables, columns, indexes and triggers. Then run authenticated integration smoke tests against staging.

## Permission decision

Use an Account API token with the Cloudflare Developer Platform **Editor** role and set the scope to **Resource → D1 → neo-staging-db** (verify the displayed database name/UUID). Cloudflare's current Developer Platform permission model supports platform-, product- and resource-level scopes; choose the single D1 resource, not all D1 databases or the whole Developer Platform.

The previous classic custom-token screen may show only generic D1 Edit. Do not use that account-wide permission. If the current Developer Platform role UI does not offer the exact `neo-staging-db` resource, stop and use an isolated Cloudflare account containing no production databases. Do not substitute a global API key, an administrator token, or the existing Worker-only deployment token.

## Recovery

D1 Time Travel is automatically enabled. Record the pre-migration bookmark from the preflight. It is the preferred point-in-time recovery mechanism for the short retention window on the current plan. Cloudflare documents seven days of history on Workers Free and 30 days on Workers Paid.

A Time Travel restore overwrites the database in place and cancels in-flight queries. It is destructive. Do not restore automatically on a migration error. First inspect the migration state and error; failed migrations should be rolled back by Wrangler. Restore only after an explicit recovery decision, using the exact saved bookmark and a second confirmation:

```sh
npx wrangler d1 time-travel restore neo-staging-db --bookmark="<SAVED_PRE_MIGRATION_BOOKMARK>"
```

Keep the separate SQL export for longer-term recovery; Time Travel retention is limited. Verify the restored schema and migration tracking table before redeploying or retrying.

## Deployment separation

The current `.github/workflows/neo-disposable-staging.yml` workflow builds the browser assets, deploys only the disposable Worker and checks `/v1/health`. It does **not** apply D1 migrations. Keep migration application as a separate, manually approved operation. Health success alone does not prove database readiness.
