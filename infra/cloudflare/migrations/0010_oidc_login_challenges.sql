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

-- Enforce the per-IP challenge issuance limit inside the same SQLite write
-- transaction as insertion, preventing concurrent requests from racing the
-- application-level preflight count.
CREATE TRIGGER IF NOT EXISTS oidc_login_challenge_rate_limit
BEFORE INSERT ON oidc_login_challenges
WHEN (
  SELECT COUNT(*) FROM oidc_login_challenges
  WHERE requester_hash = NEW.requester_hash
    AND created_at > NEW.created_at - 60
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'oidc_challenge_rate_limited');
END;
