-- Durable idempotency for offline memory writes and encrypted task enqueue.
ALTER TABLE task_leases ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS memory_write_idempotency (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, idempotency_key),
  FOREIGN KEY (account_id, memory_id, revision)
    REFERENCES memory_records(account_id, memory_id, revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_write_idempotency_by_memory
  ON memory_write_idempotency(account_id, memory_id, revision);
