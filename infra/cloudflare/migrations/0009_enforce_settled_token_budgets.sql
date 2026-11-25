-- Count already-settled usage as well as outstanding reservations when
-- enforcing monthly token budgets. Migration 0008 originally checked only
-- reserved tokens, which allowed a later reservation to exceed the monthly
-- cap after earlier requests had settled.
DROP TRIGGER IF EXISTS provider_token_budget_reserve_before_insert;

CREATE TRIGGER provider_token_budget_reserve_before_insert
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
      SELECT input_tokens + reserved_input_tokens + NEW.reserved_input_tokens > monthly_input_token_limit
        OR output_tokens + reserved_output_tokens + NEW.reserved_output_tokens > monthly_output_token_limit
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
