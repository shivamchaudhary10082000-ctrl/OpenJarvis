-- Durable, per-account monthly provider spend reservations and settlement.
-- All amounts are integer micro-USD. Provider calls must reserve their worst-case
-- configured cost before leaving the Worker. Triggers make reservation and
-- settlement accounting atomic with the reservation state transition.
CREATE TABLE IF NOT EXISTS provider_spend_usage (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  budget_microusd INTEGER NOT NULL CHECK (budget_microusd >= 0),
  reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, month_key)
);

CREATE TABLE IF NOT EXISTS provider_spend_reservations (
  reservation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd > 0),
  settled_microusd INTEGER CHECK (settled_microusd IS NULL OR settled_microusd >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  provider_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  FOREIGN KEY (account_id, month_key)
    REFERENCES provider_spend_usage(account_id, month_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS provider_spend_reservations_by_account
  ON provider_spend_reservations(account_id, month_key, state);

CREATE TRIGGER IF NOT EXISTS provider_spend_reserve_before_insert
BEFORE INSERT ON provider_spend_reservations
WHEN NEW.state = 'reserved'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM provider_spend_usage
      WHERE account_id = NEW.account_id AND month_key = NEW.month_key
    ) THEN RAISE(ABORT, 'spend_budget_missing')
  END;
  SELECT CASE
    WHEN (
      SELECT spent_microusd + reserved_microusd + NEW.reserved_microusd > budget_microusd
      FROM provider_spend_usage
      WHERE account_id = NEW.account_id AND month_key = NEW.month_key
    ) THEN RAISE(ABORT, 'spend_budget_exceeded')
  END;
  UPDATE provider_spend_usage
  SET reserved_microusd = reserved_microusd + NEW.reserved_microusd,
      updated_at = NEW.created_at
  WHERE account_id = NEW.account_id AND month_key = NEW.month_key;
END;

CREATE TRIGGER IF NOT EXISTS provider_spend_settle_after_update
AFTER UPDATE OF state ON provider_spend_reservations
WHEN OLD.state = 'reserved' AND NEW.state IN ('settled', 'released')
BEGIN
  UPDATE provider_spend_usage
  SET reserved_microusd = MAX(0, reserved_microusd - OLD.reserved_microusd),
      spent_microusd = spent_microusd + CASE
        WHEN NEW.state = 'settled' THEN COALESCE(NEW.settled_microusd, OLD.reserved_microusd)
        ELSE 0
      END,
      updated_at = COALESCE(NEW.settled_at, OLD.created_at)
  WHERE account_id = OLD.account_id AND month_key = OLD.month_key;
END;
