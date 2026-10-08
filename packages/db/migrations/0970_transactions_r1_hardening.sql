-- QA hardening r1 — transactions group (STAY-08..10 booking, EXCH-01..06 exchange, GUIDE-01..05 guide). Forward-only.

-- 1) EXCH-03: exchange_verifications rows are shown to the counterparty, so they must not hold personal data.
--    SAFETY_ACK used to store the acknowledging member's ip / user agent in `detail`. Move that evidence into the
--    append-only audit log (where new acknowledgements write it), then strip it from the verification rows.
DO $$
DECLARE
  v record;
  v_ip inet;
BEGIN
  FOR v IN
    SELECT id, exchange_id, party_user_id, detail, checked_at FROM exchange_verifications
     WHERE check_type = 'SAFETY_ACK' AND (detail ? 'ip' OR detail ? 'userAgent')
  LOOP
    BEGIN
      v_ip := nullif(v.detail->>'ip', '')::inet;
    EXCEPTION WHEN others THEN
      v_ip := NULL;
    END;
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, after_state, reason, ip, user_agent, category, created_at)
    VALUES (v.party_user_id, 'exchange.safety_acknowledged', 'exchange', v.exchange_id::text,
            jsonb_build_object('acknowledgedAt', v.detail->>'acknowledgedAt', 'verificationId', v.id),
            'migrated from exchange_verifications.detail (0970)', v_ip, v.detail->>'userAgent', 'COMPLIANCE',
            coalesce(v.checked_at, now()));
  END LOOP;
  UPDATE exchange_verifications SET detail = detail - 'ip' - 'userAgent'
   WHERE check_type = 'SAFETY_ACK' AND (detail ? 'ip' OR detail ? 'userAgent');
END $$;

-- 2) STAY-08: per-guest hold quota (concurrent live holds; holds per listing per rolling 24 h) is counted on every hold.
CREATE INDEX IF NOT EXISTS idx_reservation_holds_guest ON reservation_holds(guest_id, property_id, created_at);
