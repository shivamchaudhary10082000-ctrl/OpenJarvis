-- Terminal provider reservation rows are ledger records and must not be rewritten.
-- Prevent settlement/release transitions and settlement fields from being altered
-- after the reservation has left the reserved state.
CREATE TRIGGER IF NOT EXISTS provider_spend_terminal_reservation_immutable
BEFORE UPDATE OF state, settled_microusd, settled_input_tokens, settled_output_tokens, settled_at
ON provider_spend_reservations
WHEN OLD.state IN ('settled', 'released')
  AND (
    NEW.state IS NOT OLD.state
    OR NEW.settled_microusd IS NOT OLD.settled_microusd
    OR NEW.settled_input_tokens IS NOT OLD.settled_input_tokens
    OR NEW.settled_output_tokens IS NOT OLD.settled_output_tokens
    OR NEW.settled_at IS NOT OLD.settled_at
  )
BEGIN
  SELECT RAISE(ABORT, 'provider_reservation_terminal_immutable');
END;
