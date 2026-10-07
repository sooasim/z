-- 0600 commerce/finance extensions (PAY-01/02, FIN-01..03, TRAVEL-01..04, JET-01). Forward-only.

-- PAY-01: authoritative payable snapshot captured at prepare (split used for ledger posting at approval)
ALTER TABLE payments ADD COLUMN payable_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE payments ADD COLUMN order_name text;
CREATE INDEX idx_payments_payer ON payments(payer_id, created_at DESC);
CREATE INDEX idx_payments_status_updated ON payments(status, updated_at);

-- PAY-02: retry bookkeeping for provider cancel calls
ALTER TABLE refunds ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE refunds ADD COLUMN source text NOT NULL DEFAULT 'PLATFORM' CHECK (source IN ('PLATFORM','PROVIDER_SYNC'));
CREATE INDEX idx_refunds_status ON refunds(status, next_attempt_at);

-- FIN-03: maker-checker needs the creator
ALTER TABLE finance_rules ADD COLUMN created_by uuid;

-- FIN-02: maker-checker on settlements, per-payee items (an order can have several supplier payees)
ALTER TABLE settlements ADD COLUMN generated_by uuid;
ALTER TABLE settlement_items ADD COLUMN payee_id uuid;
ALTER TABLE settlement_items ADD COLUMN payee_account_code text;
ALTER TABLE settlement_items ADD COLUMN currency char(3);
ALTER TABLE settlement_items DROP CONSTRAINT settlement_items_source_type_source_id_key;
CREATE UNIQUE INDEX uq_settlement_items_source_payee ON settlement_items(source_type, source_id, payee_id);
CREATE INDEX idx_settlements_status ON settlements(status, created_at);
CREATE INDEX idx_payout_accounts_user ON payout_accounts(user_id, created_at DESC);

-- TRAVEL-02: explicit min-participant cutoff; TRAVEL-04 pricing snapshot / fulfilment time
ALTER TABLE travel_departures ADD COLUMN cutoff_at timestamptz;
ALTER TABLE travel_departures ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE orders ADD COLUMN pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE orders ADD COLUMN fulfilled_at timestamptz;
ALTER TABLE orders ADD COLUMN cancelled_at timestamptz;
ALTER TABLE orders ADD COLUMN cancel_reason text;
CREATE INDEX idx_orders_status_expires ON orders(status, expires_at);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_supplier ON order_items(supplier_id);
CREATE INDEX idx_travel_products_status ON travel_products(status, created_at DESC);
CREATE INDEX idx_suppliers_owner ON suppliers(owner_user_id);
ALTER TABLE suppliers ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- TRAVEL-03: versioned itinerary edits
ALTER TABLE itineraries ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE INDEX idx_itinerary_items_itinerary ON itinerary_items(itinerary_id, day_index, sort_order);

-- JET-01: lead pipeline notes
ALTER TABLE charter_requests ADD COLUMN admin_note text;
ALTER TABLE charter_requests ADD COLUMN assignee_id uuid REFERENCES users(id);
ALTER TABLE charter_requests ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_charter_requests_status ON charter_requests(status, created_at DESC);
