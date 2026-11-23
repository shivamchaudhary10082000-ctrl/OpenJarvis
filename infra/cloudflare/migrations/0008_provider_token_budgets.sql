-- Monthly token budgets complement the monetary ceiling. Reservations are
-- made for every provider candidate that may be attempted, and settled from
-- provider-reported usage (or the conservative reservation when usage is absent).
ALTER TABLE provider_spend_usage ADD COLUMN monthly_input_token_limit INTEGER NOT NULL DEFAULT 0 CHECK (monthly_input_token_limit >= 0);
ALTER TABLE provider_spend_usage ADD COLUMN monthly_output_token_limit INTEGER NOT NULL DEFAULT 0 CHECK (monthly_output_token_limit >= 0);
ALTER TABLE provider_spend_usage ADD COLUMN reserved_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0);
ALTER TABLE provider_spend_usage ADD COLUMN reserved_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0);
ALTER TABLE provider_spend_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0);
ALTER TABLE provider_spend_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0);

ALTER TABLE provider_spend_reservations ADD COLUMN reserved_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0);
ALTER TABLE provider_spend_reservations ADD COLUMN reserved_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0);
ALTER TABLE provider_spend_reservations ADD COLUMN settled_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (settled_input_tokens >= 0);
ALTER TABLE provider_spend_reservations ADD COLUMN settled_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (settled_output_tokens >= 0);

CREATE TRIGGER IF NOT EXISTS provider_token_budget_reserve_before_insert
BEFORE INSERT ON provider_spend_reservations
WHEN NEW.state = 'reserved' AND (NEW.reserved_input_tokens > 0 OR NEW.reserved_output_tokens > 0)
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM provider_spend_usage
      WHERE account_id = NEW.account_id AND month_key = NEW.month_key
    ) THEN RAISE(ABORT, 'token_budget_missing')
  END;
  SELECT CASE
    WHEN (
      SELECT reserved_input_tokens + NEW.reserved_input_tokens > monthly_input_token_limit
        OR reserved_output_tokens + NEW.reserved_output_tokens > monthly_output_token_limit
      FROM provider_spend_usage
      WHERE account_id = NEW.account_id AND month_key = NEW.month_key
    ) THEN RAISE(ABORT, 'token_budget_exceeded')
  END;
  UPDATE provider_spend_usage
  SET reserved_input_tokens = reserved_input_tokens + NEW.reserved_input_tokens,
      reserved_output_tokens = reserved_output_tokens + NEW.reserved_output_tokens,
      updated_at = NEW.created_at
  WHERE account_id = NEW.account_id AND month_key = NEW.month_key;
END;

CREATE TRIGGER IF NOT EXISTS provider_token_budget_settle_after_update
AFTER UPDATE OF state ON provider_spend_reservations
WHEN OLD.state = 'reserved' AND NEW.state IN ('settled', 'released')
BEGIN
  UPDATE provider_spend_usage
  SET reserved_input_tokens = MAX(0, reserved_input_tokens - OLD.reserved_input_tokens),
      reserved_output_tokens = MAX(0, reserved_output_tokens - OLD.reserved_output_tokens),
      input_tokens = input_tokens + CASE WHEN NEW.state = 'settled' THEN NEW.settled_input_tokens ELSE 0 END,
      output_tokens = output_tokens + CASE WHEN NEW.state = 'settled' THEN NEW.settled_output_tokens ELSE 0 END,
      updated_at = COALESCE(NEW.settled_at, OLD.created_at)
  WHERE account_id = OLD.account_id AND month_key = OLD.month_key;
END;

CREATE TRIGGER IF NOT EXISTS provider_token_settlement_within_reservation
BEFORE UPDATE OF state, settled_input_tokens, settled_output_tokens ON provider_spend_reservations
WHEN OLD.state = 'reserved' AND NEW.state = 'settled'
  AND (
    NEW.settled_input_tokens > OLD.reserved_input_tokens
    OR NEW.settled_output_tokens > OLD.reserved_output_tokens
  )
BEGIN
  SELECT RAISE(ABORT, 'token_settlement_exceeds_reservation');
END;
