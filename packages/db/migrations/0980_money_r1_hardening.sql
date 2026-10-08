-- QA hardening r1 — money group (PAY-01/02 payments & refunds, FIN-01..03 ledger / settlement / rules, TRAVEL-01..04).
-- Forward-only.

-- 1) TRAVEL-04: an option line belongs to ONE departure line of the order. Without the link, a cancellation refund of an
--    order holding several departures of the same product credited every departure with all of that product's options
--    (over-refund). createOrder fills parent_item_id for every TRAVEL_OPTION line.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS parent_item_id uuid REFERENCES order_items(id);
ALTER TABLE order_items ADD CONSTRAINT order_items_parent_option_only CHECK (parent_item_id IS NULL OR sellable_type = 'TRAVEL_OPTION');
CREATE INDEX IF NOT EXISTS idx_order_items_parent ON order_items(parent_item_id) WHERE parent_item_id IS NOT NULL;
COMMENT ON COLUMN order_items.parent_item_id IS
  'TRAVEL_OPTION lines: the TRAVEL_DEPARTURE line (same order) the option was booked with. NULL for departure lines and for legacy option lines that could not be linked unambiguously.';
-- backfill legacy option lines where the order has exactly one departure line of the option''s product
UPDATE order_items oi SET parent_item_id = m.dep_id
  FROM (
    SELECT o.id AS opt_id, (array_agg(d.id))[1] AS dep_id, count(*) AS n
      FROM order_items o
      JOIN travel_product_options po ON po.id = o.sellable_id
      JOIN order_items d ON d.order_id = o.order_id AND d.sellable_type = 'TRAVEL_DEPARTURE'
      JOIN travel_departures td ON td.id = d.sellable_id AND td.product_id = po.product_id
     WHERE o.sellable_type = 'TRAVEL_OPTION' AND o.parent_item_id IS NULL
     GROUP BY o.id
  ) m
 WHERE oi.id = m.opt_id AND m.n = 1;

-- 2) FIN-03: retiring an APPROVED fee/tax rule is a two-person change (request by one ACCOUNTING/ADMIN user, confirmation
--    by another), like its approval. DRAFT rules are still retired in one step.
ALTER TABLE finance_rules ADD COLUMN IF NOT EXISTS retire_requested_by uuid;
ALTER TABLE finance_rules ADD COLUMN IF NOT EXISTS retire_requested_at timestamptz;
ALTER TABLE finance_rules ADD COLUMN IF NOT EXISTS retire_reason text;
ALTER TABLE finance_rules ADD COLUMN IF NOT EXISTS retired_by uuid;

-- 3) FIN-02: a statement whose net is negative (refunds after a payout exceed new earnings) is not payable. It is closed
--    as CARRIED_FORWARD and its (negative) net is pulled into the payee's next statement as a CARRY_FORWARD item, so the
--    amount owed is recovered from later earnings instead of being dropped.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check
  CHECK (status IN ('DRAFT','READY','APPROVAL_PENDING','APPROVED','PAYOUT_PENDING','PAID','RECONCILED','HELD','CARRIED_FORWARD'));
CREATE INDEX IF NOT EXISTS idx_settlements_payee_open_negative ON settlements(payee_id, payee_type, currency) WHERE net_minor < 0;

-- 4) PAY-01: durable intent to void money captured at the PG that JETPOOL must not keep (duplicate capture for an
--    already-paid subject, provider/order mismatch, capture of a payment we consider cancelled). The PG cancel is executed
--    and retried outside the business transaction; payments.provider_status becomes CANCELED only once the PG confirmed.
CREATE TABLE IF NOT EXISTS payment_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  payment_key text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','DONE','FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  provider_status text,
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_payment_voids_due ON payment_voids(status, next_attempt_at);
CREATE TRIGGER payment_voids_touch BEFORE UPDATE ON payment_voids FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
