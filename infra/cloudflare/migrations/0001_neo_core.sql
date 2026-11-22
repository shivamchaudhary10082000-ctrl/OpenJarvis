-- NEO cloud data model v1 (Cloudflare D1 / SQLite).
-- Payload columns contain client-encrypted bytes or ciphertext text only.
-- Never store plaintext conversations, raw credentials, or provider API keys here.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  CHECK (length(device_id) BETWEEN 16 AND 128)
);

CREATE INDEX IF NOT EXISTS devices_by_account
  ON devices(account_id, revoked_at);

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  trust_state TEXT NOT NULL
    CHECK (trust_state IN ('pending', 'approved', 'rejected', 'quarantined', 'deleted')),
  payload_ciphertext BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  source_device_id TEXT REFERENCES devices(device_id),
  source_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tombstoned_at INTEGER,
  PRIMARY KEY (account_id, memory_id, revision)
);

CREATE INDEX IF NOT EXISTS memory_by_account_updated
  ON memory_records(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_leases (
  task_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  assigned_device_id TEXT REFERENCES devices(device_id),
  task_kind TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  lease_expires_at INTEGER,
  idempotency_key TEXT NOT NULL,
  payload_ciphertext BLOB,
  payload_nonce BLOB,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, idempotency_key),
  CHECK (
    (payload_ciphertext IS NULL AND payload_nonce IS NULL AND key_version IS NULL)
    OR (payload_ciphertext IS NOT NULL AND payload_nonce IS NOT NULL AND key_version > 0)
  )
);

CREATE INDEX IF NOT EXISTS tasks_by_account_state
  ON task_leases(account_id, state, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(device_id),
  event_type TEXT NOT NULL,
  event_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_by_account_time
  ON audit_events(account_id, created_at DESC);
