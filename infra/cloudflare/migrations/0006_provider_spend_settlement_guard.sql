-- A provider response must never settle more than the worst-case amount reserved
-- before the request was sent. This guard prevents an upstream usage payload or
-- accounting bug from silently pushing a reservation beyond the configured cap.
CREATE TRIGGER IF NOT EXISTS provider_spend_settlement_within_reservation
BEFORE UPDATE OF state, settled_microusd ON provider_spend_reservations
WHEN OLD.state = 'reserved'
  AND NEW.state = 'settled'
  AND (
    NEW.settled_microusd IS NULL
    OR NEW.settled_microusd > OLD.reserved_microusd
  )
BEGIN
  SELECT RAISE(ABORT, 'spend_settlement_exceeds_reservation');
END;

-- Reservation identity and amount are immutable after creation. Only the state,
-- settlement amount, and settlement timestamp may change during reconciliation.
CREATE TRIGGER IF NOT EXISTS provider_spend_reservation_immutable
BEFORE UPDATE OF reservation_id, account_id, month_key, reserved_microusd,
                 provider_label, created_at ON provider_spend_reservations
BEGIN
  SELECT RAISE(ABORT, 'spend_reservation_immutable');
END;
