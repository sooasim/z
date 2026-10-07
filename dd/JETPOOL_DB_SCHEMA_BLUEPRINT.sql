-- JETPOOL v2 database blueprint (PostgreSQL 17)
-- This is an implementation seed, not a substitute for reviewed migrations.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE, phone text, status text NOT NULL DEFAULT 'ACTIVE', locale text NOT NULL DEFAULT 'ko-KR',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL, scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, role)
);
CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  consent_type text NOT NULL, version text NOT NULL, granted boolean NOT NULL, evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE host_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id), display_name text, verification_status text NOT NULL DEFAULT 'PENDING', payout_profile_id uuid
);
CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), host_id uuid NOT NULL REFERENCES users(id), slug text UNIQUE,
  title text NOT NULL, property_type text NOT NULL, lat numeric(9,6), lng numeric(9,6),
  rental_enabled boolean NOT NULL DEFAULT false, exchange_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'DRAFT', currency char(3) NOT NULL DEFAULT 'KRW', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE property_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), permit_type text NOT NULL,
  permit_no text, jurisdiction text NOT NULL, valid_from date, valid_until date, status text NOT NULL DEFAULT 'PENDING', verified_at timestamptz
);
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid REFERENCES users(id), storage_key text NOT NULL UNIQUE,
  mime_type text, byte_size bigint, status text NOT NULL DEFAULT 'UPLOADING', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE property_media (
  property_id uuid NOT NULL REFERENCES properties(id), media_id uuid NOT NULL REFERENCES media_assets(id), sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY(property_id, media_id)
);
CREATE TABLE availability_days (
  property_id uuid NOT NULL REFERENCES properties(id), day date NOT NULL, status text NOT NULL DEFAULT 'AVAILABLE',
  price_minor bigint, min_nights integer NOT NULL DEFAULT 1, PRIMARY KEY(property_id, day)
);
CREATE TABLE inventory_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
  stay_range daterange NOT NULL, block_type text NOT NULL, source_type text NOT NULL, source_id uuid,
  state text NOT NULL DEFAULT 'ACTIVE', expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory_blocks ADD CONSTRAINT no_overlapping_active_property_blocks
  EXCLUDE USING gist (property_id WITH =, stay_range WITH &&) WHERE (state='ACTIVE');

CREATE TABLE booking_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), guest_id uuid NOT NULL REFERENCES users(id),
  subtotal_minor bigint NOT NULL, platform_fee_minor bigint NOT NULL DEFAULT 0, tax_minor bigint NOT NULL DEFAULT 0, total_minor bigint NOT NULL,
  currency char(3) NOT NULL, breakdown jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reservation_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), quote_id uuid NOT NULL REFERENCES booking_quotes(id), inventory_block_id uuid NOT NULL REFERENCES inventory_blocks(id),
  guest_id uuid NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'ACTIVE', expires_at timestamptz NOT NULL
);
CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), guest_id uuid NOT NULL REFERENCES users(id),
  hold_id uuid REFERENCES reservation_holds(id), status text NOT NULL, check_in date NOT NULL, check_out date NOT NULL,
  total_minor bigint NOT NULL, currency char(3) NOT NULL, quote_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exchange_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid NOT NULL REFERENCES users(id), property_a_id uuid NOT NULL REFERENCES properties(id),
  property_b_id uuid NOT NULL REFERENCES properties(id), status text NOT NULL DEFAULT 'REQUESTED', current_offer_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exchange_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exchange_id uuid NOT NULL REFERENCES exchange_requests(id), version integer NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id), proposed_dates jsonb NOT NULL, terms jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(exchange_id, version)
);
CREATE TABLE exchange_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exchange_id uuid NOT NULL UNIQUE REFERENCES exchange_requests(id), terms_version text NOT NULL,
  terms_snapshot jsonb NOT NULL, accepted_a_at timestamptz, accepted_b_at timestamptz, status text NOT NULL DEFAULT 'PENDING'
);
CREATE TABLE guide_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id), guide_type text NOT NULL, bio text, verification_status text NOT NULL DEFAULT 'PENDING', hourly_price_minor bigint, currency char(3)
);
CREATE TABLE guide_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guide_id uuid NOT NULL REFERENCES users(id), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE', CHECK(end_at > start_at)
);
CREATE TABLE guide_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), traveler_id uuid NOT NULL REFERENCES users(id), guide_id uuid REFERENCES users(id),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, scope jsonb NOT NULL, status text NOT NULL DEFAULT 'REQUESTED'
);
CREATE TABLE guide_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guide_id uuid NOT NULL REFERENCES users(id), traveler_id uuid NOT NULL REFERENCES users(id),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, price_minor bigint, currency char(3), paid boolean NOT NULL DEFAULT false
);
CREATE TABLE suppliers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid REFERENCES users(id), supplier_type text NOT NULL, status text NOT NULL DEFAULT 'PENDING');
CREATE TABLE travel_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES suppliers(id), type text NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'DRAFT', base_price_minor bigint, currency char(3));
CREATE TABLE travel_departures (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES travel_products(id), starts_at timestamptz NOT NULL, capacity integer NOT NULL, booked integer NOT NULL DEFAULT 0, min_participants integer NOT NULL DEFAULT 1);
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id uuid NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'PENDING', currency char(3) NOT NULL, total_minor bigint NOT NULL, merchant_of_record text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), sellable_type text NOT NULL, sellable_id uuid NOT NULL, qty integer NOT NULL CHECK(qty>0), amount_minor bigint NOT NULL);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, payment_key text UNIQUE, provider_order_id text NOT NULL,
  subject_type text NOT NULL, subject_id uuid NOT NULL, status text NOT NULL, amount_minor bigint NOT NULL, currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE refunds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES payments(id), amount_minor bigint NOT NULL CHECK(amount_minor>0), reason text, status text NOT NULL, provider_ref text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ledger_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_type text NOT NULL, owner_id uuid, account_type text NOT NULL, currency char(3) NOT NULL);
CREATE TABLE ledger_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_type text NOT NULL, source_type text NOT NULL, source_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ledger_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid NOT NULL REFERENCES ledger_transactions(id), account_id uuid NOT NULL REFERENCES ledger_accounts(id), debit_minor bigint NOT NULL DEFAULT 0, credit_minor bigint NOT NULL DEFAULT 0, CHECK((debit_minor=0) <> (credit_minor=0)));
CREATE TABLE settlements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payee_id uuid NOT NULL REFERENCES users(id), period_start date NOT NULL, period_end date NOT NULL, gross_minor bigint NOT NULL, fee_minor bigint NOT NULL, refund_minor bigint NOT NULL, tax_adjustment_minor bigint NOT NULL, net_minor bigint NOT NULL, currency char(3) NOT NULL, status text NOT NULL);
CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), context_type text NOT NULL, context_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE conversation_members (conversation_id uuid NOT NULL REFERENCES conversations(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL, last_read_at timestamptz, PRIMARY KEY(conversation_id,user_id));
CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id), sender_id uuid NOT NULL REFERENCES users(id), type text NOT NULL DEFAULT 'TEXT', body text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author_id uuid NOT NULL REFERENCES users(id), target_type text NOT NULL, target_id uuid NOT NULL, transaction_type text NOT NULL, transaction_id uuid NOT NULL, rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), body text, status text NOT NULL DEFAULT 'PUBLISHED', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(author_id,transaction_type,transaction_id,target_type,target_id));
CREATE TABLE disputes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), opened_by uuid NOT NULL REFERENCES users(id), context_type text NOT NULL, context_id uuid NOT NULL, status text NOT NULL DEFAULT 'OPEN', reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE webhook_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, external_event_id text, payload_hash text NOT NULL, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider, external_event_id));
CREATE TABLE idempotency_keys (scope text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL, response_status integer, response_body jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,idempotency_key));
CREATE TABLE outbox_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, event_type text NOT NULL, version integer NOT NULL DEFAULT 1, payload jsonb NOT NULL, correlation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, action text NOT NULL, resource_type text NOT NULL, resource_id text, before_state jsonb, after_state jsonb, reason text, correlation_id text, ip inet, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE migration_id_map (legacy_type text NOT NULL, legacy_id text NOT NULL, new_id uuid NOT NULL, PRIMARY KEY(legacy_type,legacy_id));
CREATE TABLE seo_redirects (legacy_path text PRIMARY KEY, target_path text NOT NULL, status_code integer NOT NULL DEFAULT 301 CHECK(status_code IN (301,302,307,308)));
CREATE TABLE feature_flags (flag_key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, rules jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX idx_properties_host ON properties(host_id);
CREATE INDEX idx_inventory_blocks_property ON inventory_blocks(property_id);
CREATE INDEX idx_reservations_guest ON reservations(guest_id, created_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_outbox_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id, created_at DESC);
