-- Opaque, revocable browser sessions. Persist only the SHA-256 of the cookie token.
-- Sessions are bound to one account, one enrolled device and its P-256 public key.
CREATE TABLE IF NOT EXISTS browser_sessions (
  session_hash TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  public_key_hash TEXT NOT NULL CHECK (length(public_key_hash) = 64),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS browser_sessions_by_account
  ON browser_sessions(account_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS browser_sessions_by_device
  ON browser_sessions(device_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS browser_sessions_by_expiry
  ON browser_sessions(expires_at);
