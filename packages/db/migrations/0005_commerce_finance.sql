-- 0005 TRAVEL-01..04, JET-01, PAY-01/02, FIN-01..03
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id),
  name text NOT NULL,
  supplier_type text NOT NULL CHECK (supplier_type IN ('TOUR_OPERATOR','TICKET','ACTIVITY','PACKAGE','TRANSPORT','CHARTER')),
  business_profile_id uuid REFERENCES business_profiles(id),
  -- who is the merchant of record for this supplier's sales: configured per G9 approval
  merchant_of_record text NOT NULL DEFAULT 'SUPPLIER' CHECK (merchant_of_record IN ('JETPOOL','SUPPLIER')),
  commission_bps integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE travel_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  type text NOT NULL CHECK (type IN ('TOUR','TICKET','ACTIVITY','PACKAGE')),
  slug text UNIQUE,
  title text NOT NULL,
  summary text,
  description text,
  city text,
  country char(2) NOT NULL DEFAULT 'KR',
  duration_minutes integer,
  base_price_minor bigint CHECK (base_price_minor IS NULL OR base_price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'KRW',
  cancellation_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancellation_policy_id uuid REFERENCES cancellation_policies(id),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','PUBLISHED','PAUSED','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER travel_products_touch BEFORE UPDATE ON travel_products FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
CREATE TABLE travel_product_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES travel_products(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE travel_departures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES travel_products(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  capacity integer NOT NULL CHECK (capacity >= 0),
  booked integer NOT NULL DEFAULT 0 CHECK (booked >= 0),
  min_participants integer NOT NULL DEFAULT 1 CHECK (min_participants >= 1),
  price_minor bigint,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','GUARANTEED','CANCELLED','DEPARTED')),
  CHECK (booked <= capacity)
);
CREATE INDEX idx_departures_product ON travel_departures(product_id, starts_at);
CREATE TABLE itineraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  start_date date,
  end_date date,
  visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','SHARED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE itinerary_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  itinerary_id uuid NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
  day_index integer NOT NULL CHECK (day_index >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  item_type text NOT NULL CHECK (item_type IN ('STAY','EXCHANGE','GUIDE','TRAVEL_PRODUCT','NOTE','TRANSPORT')),
  ref_id uuid,
  title text NOT NULL,
  start_time time,
  end_time time,
  note text
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
  buyer_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('CART','PENDING','PAYMENT_PENDING','PAID','FULFILLED','CANCELLED','PARTIALLY_REFUNDED','REFUNDED','PAYMENT_FAILED','EXPIRED')),
  currency char(3) NOT NULL,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  fee_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0,
  merchant_of_record text NOT NULL CHECK (merchant_of_record IN ('JETPOOL','SUPPLIER')),
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_buyer ON orders(buyer_id, created_at DESC);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  sellable_type text NOT NULL CHECK (sellable_type IN ('TRAVEL_DEPARTURE','TRAVEL_OPTION')),
  sellable_id uuid NOT NULL,
  supplier_id uuid REFERENCES suppliers(id),
  title text NOT NULL,
  qty integer NOT NULL CHECK (qty > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED'))
);
CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','REDEEMED','VOID')),
  issued_at timestamptz NOT NULL DEFAULT now()
);
-- JET-01 charter: content + lead only; direct booking guarded by feature flag 'charter.direct_booking' (OFF).
CREATE TABLE charter_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  contact_name text NOT NULL,
  contact_email citext NOT NULL,
  contact_phone text,
  origin text NOT NULL,
  destination text NOT NULL,
  preferred_date date,
  party_size integer NOT NULL CHECK (party_size >= 1),
  message text,
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CONTACTED','QUALIFIED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- PAY-01 payments (no PAN/CVC columns ever — invariant 9)
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('TOSS','MOCK')),
  provider_order_id text NOT NULL UNIQUE,
  payment_key text UNIQUE,
  payer_id uuid NOT NULL REFERENCES users(id),
  subject_type text NOT NULL CHECK (subject_type IN ('RESERVATION','GUIDE_BOOKING','ORDER')),
  subject_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED','CONFIRMING','APPROVED','FAILED','CANCELLED','PARTIALLY_REFUNDED','REFUNDED')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency char(3) NOT NULL,
  method text,
  provider_status text,
  receipt_url text,
  failure_code text,
  failure_message text,
  approved_at timestamptz,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_minor <= amount_minor)
);
CREATE INDEX idx_payments_subject ON payments(subject_type, subject_id);
CREATE UNIQUE INDEX uq_payments_subject_approved ON payments(subject_type, subject_id) WHERE status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED');
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  reason text NOT NULL,
  requested_by uuid,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROVIDER_PENDING','PARTIAL','REFUNDED','FAILED')),
  provider_ref text,
  failure_message text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_refunds_payment ON refunds(payment_id);

-- FIN-01 double-entry ledger (append-only, balanced per transaction — invariant 11)
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,  -- e.g. 'PLATFORM:CASH_CLEARING:KRW', 'PAYEE:<uuid>:PAYABLE:KRW'
  owner_type text NOT NULL CHECK (owner_type IN ('PLATFORM','USER','SUPPLIER','PROVIDER')),
  owner_id uuid,
  account_type text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','REVENUE','EXPENSE','EQUITY')),
  purpose text NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL,
  source_type text NOT NULL,
  source_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  reverses_transaction_id uuid REFERENCES ledger_transactions(id),
  memo text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);
CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id, created_at);
CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_tx_source ON ledger_transactions(source_type, source_id);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
CREATE OR REPLACE FUNCTION jp_ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint; n integer; cur integer;
BEGIN
  SELECT coalesce(sum(debit_minor),0), coalesce(sum(credit_minor),0), count(*), count(DISTINCT currency)
    INTO d, c, n, cur FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF n < 2 OR d <> c OR cur <> 1 THEN
    RAISE EXCEPTION 'ledger transaction % unbalanced (debit=%, credit=%, entries=%, currencies=%)', NEW.transaction_id, d, c, n, cur USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jp_ledger_check_balanced();
CREATE VIEW ledger_balances AS
  SELECT a.id AS account_id, a.code, a.account_type, a.currency,
         coalesce(sum(e.debit_minor),0) AS debit_minor, coalesce(sum(e.credit_minor),0) AS credit_minor,
         CASE WHEN a.account_type IN ('ASSET','EXPENSE') THEN coalesce(sum(e.debit_minor - e.credit_minor),0)
              ELSE coalesce(sum(e.credit_minor - e.debit_minor),0) END AS balance_minor
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
   GROUP BY a.id;

-- FIN-02 settlements & payouts
CREATE TABLE payout_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  bank_code text NOT NULL,
  account_last4 text NOT NULL CHECK (length(account_last4) = 4),
  account_token text NOT NULL,     -- tokenized reference held by payout provider; never full account number
  holder_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id uuid NOT NULL REFERENCES users(id),
  payee_type text NOT NULL CHECK (payee_type IN ('HOST','GUIDE','SUPPLIER')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  gross_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  refund_minor bigint NOT NULL,
  tax_adjustment_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','APPROVAL_PENDING','APPROVED','PAYOUT_PENDING','PAID','RECONCILED','HELD')),
  payout_account_id uuid REFERENCES payout_accounts(id),
  approved_by uuid,
  approved_at timestamptz,
  paid_at timestamptz,
  payout_ref text,
  hold_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (net_minor = gross_minor - fee_minor - refund_minor + tax_adjustment_minor),
  UNIQUE (payee_id, payee_type, period_start, period_end, currency)
);
CREATE TABLE settlement_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  gross_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  refund_minor bigint NOT NULL DEFAULT 0,
  UNIQUE (source_type, source_id)
);
-- FIN-03 effective-dated fee / tax / evidence rules (approval required)
CREATE TABLE finance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type text NOT NULL CHECK (rule_type IN ('PLATFORM_FEE','HOST_FEE','TAX','WITHHOLDING','EVIDENCE')),
  domain text NOT NULL CHECK (domain IN ('STAY','GUIDE','TRAVEL','EXCHANGE','*')),
  jurisdiction text NOT NULL DEFAULT 'KR',
  params jsonb NOT NULL,   -- {"bps": 1000} or {"flat_minor": 1000} ; tax: {"bps": 1000, "inclusive": false}
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  approved_by uuid,
  approved_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_finance_rules_lookup ON finance_rules(rule_type, domain, jurisdiction, status, effective_from);
CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  payment_id uuid REFERENCES payments(id),
  receipt_type text NOT NULL CHECK (receipt_type IN ('PAYMENT','REFUND','SETTLEMENT_STATEMENT','TAX_EVIDENCE')),
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_receipts_user ON receipts(user_id, issued_at DESC);
