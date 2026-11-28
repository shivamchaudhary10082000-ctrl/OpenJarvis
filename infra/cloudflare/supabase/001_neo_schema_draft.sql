-- NEO PostgreSQL/Supabase schema draft. This is an isolated-port baseline,
-- not yet applied to any Supabase project. Ciphertext payloads only.
create schema if not exists neo;
revoke all on schema neo from public, anon, authenticated;
grant usage on schema neo to service_role;

create table neo.accounts (
  account_id text primary key, created_at bigint not null, status text not null default 'active'
    check (status in ('active','suspended','deleted'))
);
create table neo.devices (
  device_id text primary key, account_id text not null references neo.accounts(account_id) on delete cascade,
  label text not null, platform text not null, public_key_jwk text not null,
  capabilities_json jsonb not null default '[]'::jsonb, created_at bigint not null,
  last_seen_at bigint, revoked_at bigint, check(length(device_id) between 16 and 128)
);
create index devices_by_account on neo.devices(account_id,revoked_at);
create table neo.memory_records (
  sync_id bigint generated always as identity primary key,
  memory_id text not null, revision integer not null check(revision>0),
  account_id text not null references neo.accounts(account_id) on delete cascade,
  trust_state text not null check(trust_state in ('pending','approved','rejected','quarantined','deleted')),
  payload_ciphertext bytea not null, payload_nonce bytea not null, key_version integer not null check(key_version>0),
  source_device_id text references neo.devices(device_id), source_kind text not null,
  created_at bigint not null, updated_at bigint not null, tombstoned_at bigint,
  unique(account_id,memory_id,revision)
);
create index memory_by_account_updated on neo.memory_records(account_id,updated_at desc);
create index memory_by_account_sync on neo.memory_records(account_id,sync_id);
create table neo.task_leases (
  task_id uuid primary key, account_id text not null references neo.accounts(account_id) on delete cascade,
  assigned_device_id text references neo.devices(device_id), task_kind text not null,
  state text not null check(state in ('queued','leased','running','succeeded','failed','cancelled')),
  lease_expires_at bigint, idempotency_key text not null, payload_ciphertext bytea,
  payload_nonce bytea, key_version integer, created_at bigint not null, updated_at bigint not null,
  required_capabilities_json jsonb not null default '[]'::jsonb, request_hash text not null default '',
  unique(account_id,idempotency_key),
  check((payload_ciphertext is null and payload_nonce is null and key_version is null)
     or (payload_ciphertext is not null and payload_nonce is not null and key_version>0))
);
create index tasks_by_account_state on neo.task_leases(account_id,state,created_at);
create table neo.audit_events (
  event_id uuid primary key, account_id text not null references neo.accounts(account_id) on delete cascade,
  device_id text references neo.devices(device_id), event_type text not null,
  event_metadata_json jsonb not null default '{}'::jsonb, created_at bigint not null
);
create index audit_by_account_time on neo.audit_events(account_id,created_at desc);
create table neo.device_nonces (
  device_id text not null references neo.devices(device_id) on delete cascade,
  nonce text not null, expires_at bigint not null, primary key(device_id,nonce)
);
create index device_nonces_expiry on neo.device_nonces(expires_at);
create table neo.api_rate_limits (
  account_id text primary key references neo.accounts(account_id) on delete cascade,
  window_start bigint not null, request_count integer not null check(request_count>=0)
);
create table neo.memory_write_idempotency (
  account_id text not null references neo.accounts(account_id) on delete cascade,
  idempotency_key text not null check(length(idempotency_key) between 16 and 128),
  memory_id text not null, revision integer not null, request_hash text not null, created_at bigint not null,
  primary key(account_id,idempotency_key),
  foreign key(account_id,memory_id,revision) references neo.memory_records(account_id,memory_id,revision)
);
create index memory_write_idempotency_by_memory on neo.memory_write_idempotency(account_id,memory_id,revision);
create table neo.oidc_login_challenges (
  challenge_hash text primary key, requester_hash text not null,
  created_at bigint not null, expires_at bigint not null, consumed_at bigint
);
create index oidc_challenges_by_requester on neo.oidc_login_challenges(requester_hash,created_at);
create index oidc_challenges_expiry on neo.oidc_login_challenges(expires_at,consumed_at);
create table neo.provider_spend_usage (
  account_id text not null references neo.accounts(account_id) on delete cascade,
  month_key text not null, budget_microusd bigint not null check(budget_microusd>=0),
  monthly_input_token_limit bigint not null default 0 check(monthly_input_token_limit>=0),
  monthly_output_token_limit bigint not null default 0 check(monthly_output_token_limit>=0),
  reserved_microusd bigint not null default 0 check(reserved_microusd>=0),
  spent_microusd bigint not null default 0 check(spent_microusd>=0),
  reserved_input_tokens bigint not null default 0 check(reserved_input_tokens>=0),
  reserved_output_tokens bigint not null default 0 check(reserved_output_tokens>=0),
  input_tokens bigint not null default 0 check(input_tokens>=0),
  output_tokens bigint not null default 0 check(output_tokens>=0),
  updated_at bigint not null, primary key(account_id,month_key)
);
create table neo.provider_spend_reservations (
  reservation_id uuid primary key, account_id text not null, month_key text not null,
  reserved_microusd bigint not null check(reserved_microusd>0),
  settled_microusd bigint check(settled_microusd is null or settled_microusd>=0),
  reserved_input_tokens bigint not null default 0 check(reserved_input_tokens>=0),
  reserved_output_tokens bigint not null default 0 check(reserved_output_tokens>=0),
  settled_input_tokens bigint not null default 0 check(settled_input_tokens>=0),
  settled_output_tokens bigint not null default 0 check(settled_output_tokens>=0),
  state text not null check(state in ('reserved','settled','released')), provider_label text not null,
  created_at bigint not null, settled_at bigint,
  foreign key(account_id,month_key) references neo.provider_spend_usage(account_id,month_key) on delete cascade
);
create index spend_reservations_by_account on neo.provider_spend_reservations(account_id,month_key,state);
-- Privileged Worker-only data access. Keep schema outside exposed public API and
-- deny all browser/mobile role access. A dedicated DB connection or tightly
-- controlled RPC layer is required; do not grant service_role to clients.
