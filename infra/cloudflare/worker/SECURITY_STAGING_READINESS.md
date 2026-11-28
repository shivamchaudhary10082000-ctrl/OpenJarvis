# NEO Worker security review and disposable staging readiness

Status: 2026-11-28. This is an engineering readiness review, not a production-readiness approval.

## Scope

- Repository: shivamchaudhary10082000-ctrl/OpenJarvis.
- Branch: neo/foundation-architecture.
- PR #1 remains Draft, open, unmerged, and targeted at main.
- The main branch, production, billing, paid providers, and the separate Supabase project remain untouched.

## Current code-level verification

Worker CI run #46104374656 (run 406) completed successfully on the reviewed branch head before this documentation update:

- OpenAPI lint, TypeScript check, and Wrangler deployment dry-run passed.
- Vitest: 3 files, 76 tests passed.
- Browser persistence: 15/15 passed across Chromium, Firefox, and WebKit.

The authentication integration tests use mocked OIDC/JWKS and local SQLite-backed D1. They exercise one-use challenge and nonce handling, a Google-shaped RS256 token, P-256 browser-device enrollment, hash-only session-token persistence, Secure/HttpOnly/SameSite=Strict browser session issuance, signed same-origin heartbeat, logout and revocation, cross-origin rejection, and the fail-closed no-provider chat response. They do not prove a real Google login, live Cloudflare D1, or live authenticated chat.

## Disposable Worker deployment and health

The last successful disposable deployment that was retrieved is run #45909896048, dated 2026-11-26. It deployed commit e63c6c97b01c420915d6dc0cff236bbeef3db467 and reported Worker version 5ffdb1a6-390a-483a-a2c2-052d11e9ecf7. Its runner-side health probe returned:

- status: ok
- environment: disposable-staging

That deployment is not the current engineering-branch code. The branch has since changed Worker/client code and migration/security work. No current-head staging deployment was performed because the remote D1 schema and recovery state remain unverified. The health route is availability evidence only, not proof of authenticated D1 operations.

An independent probe from this environment could not resolve the workers.dev hostname. I am not claiming a second live probe.

## D1 migration status

Exact source database:

- Database: neo-staging-db
- UUID: dd4c03d6-a286-4ac9-abbc-8f162b692acc

The latest retrieved read-only preflight is run #45910522233:

- The exact source UUID was verified.
- A Time Travel bookmark was obtained.
- SQL export was completed on the ephemeral runner, with Wrangler output suppressed to avoid exposing a temporary signed URL.
- At that time, migrations 0001–0011 were pending.
- The preflight skipped all schema writes; no migration was applied.

Migration 0012 was added after that preflight. The remote migration list has not been rechecked against the current 12-file chain. Do not assume a current pending count until another read-only preflight.

The migration approval file remains NO. The restore attestation remains RESTORE_VERIFIED=NO.

## Migration and recovery verification on an isolated environment

NEO exact D1 migration SQLite rehearsal run #46104374713 passed:

- The remote migration gate's allow-list matches the exact 12-file migration chain.
- All 12 migration SQL files executed against isolated SQLite.
- 34 schema objects were created.
- Foreign-key checks and SQLite integrity check passed.
- The rehearsal verified provider reservation accounting, over-budget rejection, settlement, release, and migration 0012's immutable terminal-reservation trigger.

This is isolated SQLite evidence only. It did not connect to or change Cloudflare D1.

NEO encrypted D1 backup artifact rehearsal run #46104374770 also passed:

- SQL-import sanitizer removed transaction wrappers and the reserved _cf_KV table in a synthetic fixture.
- A synthetic database was encrypted before artifact upload.
- Artifact download and checksum verification passed.
- Tampering was detected.
- Decryption, isolated SQLite restore, integrity, and foreign-key validation passed.

This is a synthetic pipeline rehearsal, not a backup or restore of the real staging D1.

## Backup and recovery gate

The recovery design does not depend on R2:

- The backup-only workflow requires a separate, narrowly scoped source-D1 export credential and the owner's public age recipient.
- It exports SQL, encrypts before upload, and uploads ciphertext, checksum, and metadata only.
- The private age identity remains owner-held and offline; it must never be placed in GitHub, repository files, chat, or runner storage.
- The owner-local restore script requires a separate token scoped only to the recovery D1. It validates the exact target UUID and empty-target precondition, restores only to the recovery database, and compares schema and table contents with the decrypted source.
- Migration apply remains separate and requires the exact backup artifact plus owner-local restore attestation. The current approval label is APPLY_0001_0012; both approval and restore attestation remain NO.

No real staging backup, owner-local decryption, or restore to the recovery D1 has been demonstrated.

## Authentication readiness

- The Google Web client ID variable was present and passed the format check during staging preflight.
- Real Google browser OAuth, authorized-origin behavior, test-user configuration, and session issuance/resume/revocation against live D1 have not been verified.
- The code-level OIDC/security tests are mocked and local-D1 tests.
- The current deployed Worker is stale relative to the branch; the live health probe did not exercise the current branch's authentication or D1 schema.

## Provider isolation and spending

The disposable Worker configuration keeps provider URLs and model names unset and all spend/token/voice budgets at zero. The tested chat path returns model_unconfigured without an upstream call. No paid provider or billing activation was performed.

## Required next steps

1. Confirm or create a source-D1 export token scoped only to neo-staging-db and a separate recovery-D1 token scoped only to neo-staging-recovery-test. Do not reuse the previously inspected account-wide D1 Write token.
2. Create/retain the owner-held age identity offline and place only its public recipient in the GitHub variable.
3. Run the separate backup-only workflow, download the exact ciphertext artifact to the owner's device, and verify its checksum.
4. Decrypt locally and restore to the separate recovery D1; capture schema, row comparison, integrity, and foreign-key evidence.
5. Only after that evidence is reviewed, obtain explicit owner approval for a fresh preflight and any migration apply. No apply is authorized here.
6. After remote migration and schema verification, perform a real Google OAuth round-trip, device enrollment, session issue/resume/logout/revocation, and authenticated safe no-provider smoke test.

## Explicit non-claims

- No remote D1 migration has been applied.
- No durable real-staging backup or recovery restore has been proven.
- No real Google sign-in or live session/authenticated chat has been proven.
- The current branch Worker has not been deployed to staging.
- No paid AI provider, billing, production, main-branch merge, or separate Supabase project has been touched.
