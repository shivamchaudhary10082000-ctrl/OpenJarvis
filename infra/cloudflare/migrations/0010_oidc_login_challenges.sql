-- Short-lived, one-time OIDC nonce challenges for first-device enrollment.
-- Store only a hash of the nonce and requester IP; never persist bearer tokens.
CREATE TABLE IF NOT EXISTS oidc_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  requester_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS oidc_login_challenges_by_requester
  ON oidc_login_challenges(requester_hash, created_at);
CREATE INDEX IF NOT EXISTS oidc_login_challenges_expiry
  ON oidc_login_challenges(expires_at, consumed_at);
