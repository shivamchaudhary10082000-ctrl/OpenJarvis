# NEO progressive release strategy

**Decision date:** 2026-11-24  
**Target:** first usable NEO access before 2027-01-01, then incremental updates without waiting for every planned capability.

This strategy supersedes a single all-or-nothing launch. It does not lower the security bar or redefine a diagnostic harness as a usable assistant.

## Release stages

### NEO Alpha — first real conversation
The Alpha is the earliest release that a user can actually sign into and converse with from an authorised device.

Required before Alpha:
- A real HTTPS-hosted NEO entry point and an explicit, tested authentication flow.
- Android and browser clients connected to the same staging Worker.
- Successful device enrolment, signed requests, revocation and account isolation.
- A real text conversation through the authenticated `/chat/completions` route and an approved model provider.
- Strict per-request and monthly spend/token ceilings, provider pricing verified against the selected provider, and no inference when limits are absent or exhausted.
- Clear error handling for expired sessions, unavailable providers, network loss and blocked spend.
- No production data; disposable staging only until release approval.

Alpha is **not** satisfied by source code, a CI pass, a local diagnostic APK, a mocked provider, or a Worker health response.

### NEO Beta — continuity and memory
- Persistent conversations and user-controlled memory.
- Client-side encryption and key lifecycle/recovery validated end to end.
- Memory approval/rejection, sync, conflict handling and offline outbox replay across authorised devices.
- Android and iPad/browser parity for core text workflows.

### NEO Voice
- Voice capture, transcription, response synthesis and playback.
- Permission, timeout, retry, provider-failure and per-request billing tests.
- Voice remains disabled unless provider pricing and hard limits are explicitly configured.

### NEO Multi-device and task coordination
- Enrolment and revocation across Android and browser devices.
- Availability/heartbeat, task leases, retries, idempotency and recovery.
- A device-independent design: no single personal computer is required to remain online as NEO's permanent brain.

### NEO 1.0
- Integrated release requirements, security review, backup/restore and rollback rehearsal.
- Critical Android/browser end-to-end tests passed against the release candidate.
- Hindi, Gujarati, Hinglish and English quality assessed; unsupported language quality is not advertised.
- Production launch only after a separate explicit owner approval.

## Delivery and update policy

- Ship the smallest secure, genuinely usable stage as soon as its acceptance gates pass.
- Continue Beta, Voice and multi-device work in parallel where interfaces are stable.
- Keep production isolated. Use disposable staging for integration and destructive recovery tests.
- Publish a concise change log for each update, including data/schema compatibility, migration behavior and rollback instructions.
- Never silently reset device identity, memory keys, account scope or user data during an update.
- Prefer backward-compatible API/schema changes; version and rehearse any unavoidable migration.
- Keep spending fail-closed. No provider secrets, paid calls, Cloudflare resources, DNS changes or production deployments without the owner's explicit approval.
- Preserve the open Draft PR and protected `main` until the normal review/release gates are satisfied.

## Current hard blockers for Alpha

1. The repository contains Worker and client transport foundations, but no finished NEO user-facing chat application.
2. No actual NEO hostname, hosting topology or Cloudflare Access application has been selected/configured.
3. The Worker chat proxy exists, but no real provider has been selected, configured or tested; non-test budgets and pricing remain zero, so inference is intentionally blocked.
4. Android's current installable `NEO Device Test` APK is a local-only diagnostic harness. It is not the Alpha app and does not contact the Worker.
5. Disposable Cloudflare Access + D1 staging, remote migrations, real authentication, remote device enrolment and remote chat smoke tests remain unperformed.
6. The Android/browser memory transport currently handles encrypted wire records, but an end-to-end client encryption-key lifecycle and safe recovery path still need implementation and validation.

## Owner-assisted gates

Ask the owner only when the next step changes their account, costs money, creates external infrastructure, selects an identity/provider/hostname, or requires a physical-device action. In particular, obtain explicit approval before creating Cloudflare resources or configuring paid inference. Never request secrets in chat; use the provider's secure secret settings when approved.

## Evidence rule

Track **engineering implementation** and **release validation** separately. A stage is usable only when its acceptance criteria have been exercised through the real client, real staging endpoint and real provider path where applicable. Mark anything not tested in that environment as unverified.
