-- Durable fixed-window API rate limits, keyed by account rather than Worker isolate.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);
