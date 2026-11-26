# NEO Worker security review and disposable staging readiness

Status as of 2026-11-27. This document separates local/code-level evidence from remote staging evidence. It is not a production-readiness approval.

## Branch and scope

- Repository: `shivamchaudhary10082000-ctrl/OpenJarvis`.
- Engineering branch: `neo/foundation-architecture`.
- Current branch head when this review was updated: `993264105aac60550def09883b054370507dfc81`.
- Latest code/test change: `c728e40f83b4ea8a2554c548bfab56ec8cf75f19`.
- PR [#1](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/pull/1) remains Draft, open, unmerged, and targeted at `main`.
- No changes to `main`, production, billing, paid providers, or the separate Supabase physiotherapy project.

## Latest code-level verification

Worker CI [run #45913221303](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221303) passed on the current docs head. It ran:

- OpenAPI lint, TypeScript check, Wrangler deploy dry-run.
- Vitest: **73/73 tests passed** across 3 files.
- Playwright browser persistence: **9/9 passed** across Chromium, Firefox and WebKit.

The new browser-session integration assertions in `test/security.integration.test.ts` exercise this simulated path using generated test signing keys and local SQLite-backed D1:

1. Request a one-use OIDC challenge.
2. Verify a nonce-bound Google-shaped RS256 ID token using mocked Google JWKS.
3. Enrol a browser P-256 device.
4. Issue a Secure, HttpOnly, SameSite=Strict `__Host-neo_session` cookie and verify only its SHA-256 hash is stored.
5. Resume the browser session and complete a signed same-origin heartbeat.
6. Submit authenticated `POST /v1/chat/completions` with no provider URL, key, or budget configured; expect `503 model_unconfigured` and zero upstream calls.
7. Reject cross-origin mutation, log out, clear the cookie, and reject the revoked session.

A separate integration test verifies one-use challenge replay rejection. These are **mocked OIDC/local-D1 integration tests**, not a real Google browser login or a live Cloudflare D1 test. The no-provider chat result is the expected safe failure path; it is not an AI response.

Other latest-head workflow results at the time of this review:
- Web Alpha [#45913221316](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221316): success.
- Frontend CI [#45913221258](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221258): success.
- Memory safety [#45913221263](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221263): success.
- Installer integration [#45913221309](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221309): all five platform jobs passed.
- Deploy Documentation [#45913221310](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221310): build passed; deploy intentionally skipped.
- Android unit job in [#45913221311](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221311): passed after a previous retry hit Maven Central HTTP 429. Emulator instrumentation was still running at the time of this update.
- General CI [#45913221463](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221463), Docker validation [#45913221242](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221242), and Desktop Build & Release [#45913221255](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45913221255) still had jobs running. Release/publish jobs were skipped as intended.

## Disposable Worker deployment

The last successful disposable deployment is [run #45909896048](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45909896048), deploying code commit `e63c6c97b01c420915d6dc0cff236bbeef3db467` to `neo-api-disposable-staging`. It reported Worker version `5ffdb1a6-390a-483a-a2c2-052d11e9ecf7` and a successful health response:

```json
{"status":"ok","environment":"disposable-staging"}
```

Subsequent changes in this review are tests and documentation; the deployment workflow skipped on the latest head because no staging-deploy marker or manual deployment confirmation was supplied. The health result proves Worker availability only. It does not prove D1-backed authentication, browser sessions, or chat work remotely.

## Google OAuth configuration status

- The GitHub Actions variable `NEO_GOOGLE_WEB_CLIENT_ID` was present and passed the disposable workflow's non-empty and `.apps.googleusercontent.com` format checks during preflight.
- The disposable Worker template maps that value to `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_IDS`.
- The Google Auth Platform console's authorized JavaScript origins, redirect configuration, publishing/testing state, and test-user list could not be independently re-read through the connected repository tooling in this run.
- No real browser OAuth round-trip was performed. A populated client ID variable is not proof that Google will accept the deployed origin or that the user can complete sign-in.

## Remote D1 status — blocking

Exact target:
- Database: `neo-staging-db`
- UUID: `dd4c03d6-a286-4ac9-abbc-8f162b692acc)

Latest read-only preflight: [run #45910522233](https://github.com/shivamchaudhary10082000-ctrl/OpenJarvis/actions/runs/45910522233), job `140217498701`:

- Exact D1 identity verified.
- Time Travel bookmark obtained.
- SQL export completed on the ephemeral runner; Wrangler output was suppressed to avoid logging its temporary signed export URL.
- **All migrations 0001–0011 are pending.**
- R2 backup upload, migration apply, and schema verification were skipped. No remote schema changes were made.
- `infra/cloudflare/D1_MIGRATION_APPROVAL.txt` remains `NO`.

No durable encrypted backup, downloaded-ciphertext checksum verification, owner-held decryption, or isolated restore to a separate D1 database has been demonstrated.

## Backup/recovery gate

The current `.github/workflows/neo-disposable-staging.yml` is not yet suitable for the required recovery sequence:

- `PREFLIGHT_ONLY` exports to temporary runner storage and skips R2.
- `APPLY_0001_0011` runs the R2 upload/download-checksum step and then immediately applies migrations. There is no backup-only mode or owner-restore attestation pause.
- The previously inspected D1 migration token had account-wide D1 Write scope. Do not use it as a substitute for a narrowly scoped read/export credential or create a broader token.
- The R2 step was skipped in the latest preflight. GitHub secret values and the Cloudflare account's bucket inventory are not visible through this connector; therefore an unexecuted R2 step is not proof that a private bucket or bucket-scoped credentials are configured.
- The detailed prerequisites and recovery order are in [D1_BACKUP_RECOVERY_RUNBOOK.md](D1_BACKUP_RECOVERY_RUNBOOK.md).

Do not set `APPLY_0001_0011` to obtain a backup. Keep the approval file at `NO`.

## Provider isolation and spend guard

The disposable Worker template has:
- Primary and backup model URLs empty and model names `unset`.
- Monthly USD spend limit `0`.
- Monthly input-token and output-token limits `0`.
- Per-provider prices and voice request ceilings `0`.

The new authenticated chat integration test confirms the no-provider path returns `503 model_unconfigured` without an upstream call. No paid provider was activated or contacted.

## Remaining work, in safe order

1. Prove an existing private R2 bucket and bucket-scoped Object Read + Object Write credentials; prove a narrowly scoped D1 read/export credential. If unavailable, stop without creating resources or widening permissions.
2. Implement and review a separate backup-only workflow. It must not apply migrations.
3. Export the exact source D1, encrypt before upload with the owner's public age recipient, download the same ciphertext, and verify SHA-256.
4. Owner decrypts offline with the owner-held private key and restores to a separate disposable D1. Record the backup object key/hash and restore evidence.
5. Strengthen the apply workflow with an explicit restore attestation. Reconfirm the source UUID and pending migration set before applying only 0001–0011.
6. Verify all 11 migration-history entries, all expected tables/indexes/triggers, foreign-key definitions and zero `PRAGMA foreign_key_check` violations. Keep scheduled maintenance disabled until verified; reset approval to `NO`.
7. Only after the remote schema exists, run real Google browser login, challenge replay rejection, device enrollment, session issue/resume/logout, authenticated chat and the safe no-provider path against the live disposable Worker/D1.
8. Keep provider URLs/secrets unset and budgets at zero. Production, release, billing, and Supabase remain out of scope.

## Explicit non-claims

- No real Google sign-in, live D1 session, live authenticated chat, or D1 migration has been proven.
- No durable staging backup or real restore has been proven.
- Android emulator/CI checks do not equal physical-device validation.
- A green Worker health endpoint does not equal a working end-to-end NEO deployment.
