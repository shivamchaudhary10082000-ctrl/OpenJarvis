# NEO architecture: cloud-first, device-independent

Status: proposed implementation baseline. Nothing in this document implies that a Cloudflare account has been connected or that a service has been deployed.

## Product contract

NEO is one personal assistant identity available from multiple authorised devices. A phone, tablet, laptop, browser, or future device is a client or an optional compute worker; no physical device is the permanent source of truth.

- Cloud services own identity, task coordination, encrypted durable state, model routing, and audit history.
- Devices keep only credentials, a small encrypted cache, unsent actions, and optional local/offline model assets.
- Any online authorised device can resume the same conversation and access the same approved memory and skills.
- A device may contribute compute only while online, healthy, and explicitly enabled for that class of task.
- When every device is offline, cloud inference and cloud sync are unavailable. The current device may use an explicitly configured local fallback.

## Target topology

```text
Phone / Tablet / Browser / Desktop
  - device key + short-lived session
  - small encrypted cache + offline outbox
  - microphone / speaker / OS permission adapter
                  |
                  | HTTPS / streaming
                  v
Cloudflare edge gateway (Workers)
  - authenticate Cloudflare Access JWT
  - bind requests to a pseudonymous account ID + registered device
  - rate limits, request IDs, idempotency, policy checks
  - model router / provider adapters
       |             |                 |
       v             v                 v
     D1           Durable Objects   Inference providers
  accounts,       per-account       primary / backup /
  devices,        ordering,         optional Workers AI /
  memory metadata task leases       cloud GPU endpoint
       |
       v
      R2
  encrypted attachments, exports, snapshots, large blobs

Optional online laptop/desktop compute workers register capabilities and
receive explicitly delegated, leased tasks. They are never required for
normal cloud inference.
```

## Cloudflare responsibilities

| Component | Use | Do not use it for |
|---|---|---|
| Workers | API gateway, auth verification, policy enforcement, routing, streaming proxy | Running large model weights or treating isolate memory as durable RAM |
| D1 | Relational metadata, device registry, task state, memory record metadata, idempotency | Large files or raw model weights |
| Durable Objects | Per-account ordering, device presence, task leases, conflict coordination | The only copy of durable data; in-memory state can be evicted |
| R2 | Encrypted attachments, exports, backups, snapshots | A SQL database, RAM, or model inference |
| Workers AI / AI Gateway | Candidate inference and provider observability/routing where suitable | Assuming every available model meets NEO's Hindi/Hinglish quality bar |

The inference layer must remain provider-neutral. A model's availability in a catalogue is not evidence that it is good enough for NEO.

## Identity and device trust

1. The account identity is independent of any device. Device IDs are random identifiers, not usernames or secrets.
2. Enrolment requires an authenticated account session and a device-generated public/private key pair.
3. Store public keys and revocation state server-side; keep private keys in the platform secure keystore where available.
4. Use short-lived access tokens, rotation, nonce-bound device proofs, replay protection, and server-side revocation.
5. Every request is authorised against both account and device. A valid account token alone must not bypass device revocation.
6. New devices require an explicit user-approved enrolment flow. High-risk actions require fresh confirmation.
7. Audit enrolment, revocation, model/provider changes, exports, memory approvals, and capability grants.

Do not invent a custom password protocol or store reusable provider API keys on a phone. Use a supported identity provider and platform secure storage.

## Memory and synchronisation

- New memory candidates stay pending until explicit user approval. Rejected and scanner-flagged candidates never enter model context.
- Each memory item has an immutable ID, account ID, schema version, revision, timestamps, source/provenance, trust state, and deletion tombstone.
- Mutations are idempotent and revision-checked. Conflicts are surfaced or merged deterministically; last-write-wins must not silently overwrite a user-approved fact.
- Keep large attachments in R2 and structured metadata in D1.
- Preferred privacy mode: encrypt memory payloads on the client before upload. This prevents the service from reading the contents, but also prevents server-side semantic search. If server-side semantic search is later enabled, it must be a separately disclosed, opt-in privacy mode.
- Sync only approved memory by default. Pending candidates may sync as encrypted review items but remain non-recallable on every device.
- Deletion must propagate as a tombstone and be applied to caches and replicas.

## Model routing: no silent downgrade

Define three explicit tiers:

1. Primary: best quality model that passes NEO's language and task evaluations within the configured budget.
2. Backup: independently hosted provider/model with a separately measured quality profile.
3. Offline fallback: a local model on an available device, clearly identified as lower capability.

Routing rules:

- Explicit user model selection is honoured or fails with a clear error; it is never silently replaced.
- Automatic routing records selected provider, model, tier, reason, and fallback event in the response metadata.
- A provider outage may trigger the next permitted tier only if policy allows it. The UI must disclose the switch before or with the answer.
- If the monthly budget or per-request cap is reached, stop or ask for approval. Do not silently switch to a materially weaker model.
- Provider credentials live only in server-side secrets. Never ship them to clients.
- Use request timeouts, bounded retries, circuit breakers, per-user quotas, and idempotency keys.

## Hindi/Hinglish quality gate

NEO must be tested on natural Roman Hindi, Devanagari Hindi, English, and mixed Hindi-English—not merely on English benchmarks. The evaluation set lives at `evals/neo/hinglish_v1.jsonl`.

Score each response for:
- intent and context understanding;
- natural conversational Hinglish/Hindi (not literal machine translation);
- appropriate script/register matching the user's input;
- multi-turn consistency and memory use;
- factual correctness and calibrated uncertainty;
- instruction following and refusal quality;
- latency and cost.

No model becomes primary solely because it is cheap, fast, or listed by a provider. Require blind human review on a representative sample before changing the default.

## Voice and device integrations

- Microphone access is foreground-only by default. Wake-word/background listening is a separate opt-in permission.
- Show the active capture state and provide a visible stop control.
- Voice recordings are not retained by default. Retention, transcription, and provider processing are disclosed.
- Speech-to-text, model inference, and text-to-speech are replaceable services. Keep a text-only path available.
- OS actions are capabilities, not ambient permissions. Request access per capability and confirm consequential actions.
- Offline actions enter an encrypted outbox with idempotency keys and are replayed only after authentication is restored.

## Rollout gates

1. Memory safety tests pass and a security review accepts the trust boundary.
2. Cloud schema and API contracts are tested locally; authentication and device revocation are tested.
3. A staging deployment is exercised with synthetic data only.
4. Model benchmark results meet the language-quality threshold and budget policy.
5. Two-device sync, conflict, revocation, offline queue, and recovery tests pass.
6. Voice permissions and data-retention tests pass on actual Android hardware.
7. Production deployment requires explicit owner approval and a rollback plan.

## Current implementation boundary

The current branch has OpenJarvis memory approval changes and a focused CI workflow. Cloudflare account provisioning, Access application setup, R2/D1 creation, provider credentials, DNS, production deployment, native Android integration, and real-device testing are not performed by repository commits alone. Keep all deployments disabled until those external prerequisites are deliberately configured.
