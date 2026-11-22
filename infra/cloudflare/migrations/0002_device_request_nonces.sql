-- Replay protection for signed device requests.
CREATE TABLE IF NOT EXISTS device_nonces (
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS device_nonces_expiry ON device_nonces(expires_at);
