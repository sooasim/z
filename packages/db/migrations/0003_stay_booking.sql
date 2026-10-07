-- 0003 STAY-01..10 (listing, media, compliance, search, favorites, availability, quote, hold, reservation)
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id),
  storage_key text NOT NULL UNIQUE,
  public_url text,
  purpose text NOT NULL DEFAULT 'PROPERTY' CHECK (purpose IN ('PROPERTY','AVATAR','VERIFICATION','EVIDENCE','MESSAGE','CMS','TRAVEL_PRODUCT','GUIDE')),
  visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','PUBLIC')),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text,
  width integer, height integer, duration_ms integer,
  moderation_status text NOT NULL DEFAULT 'PENDING' CHECK (moderation_status IN ('PENDING','APPROVED','REJECTED')),
  status text NOT NULL DEFAULT 'UPLOADING' CHECK (status IN ('UPLOADING','PROCESSING','READY','REJECTED','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);
CREATE INDEX idx_media_owner ON media_assets(owner_id, created_at DESC);

CREATE TABLE cancellation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  -- ordered tiers: [{"min_hours_before": 168, "refund_pct": 100}, ...]
  tiers jsonb NOT NULL,
  service_fee_refundable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES users(id),
  slug text UNIQUE,
  title text NOT NULL,
  summary text,
  description text,
  property_type text NOT NULL CHECK (property_type IN ('APARTMENT','HOUSE','VILLA','HANOK','GUESTHOUSE','ROOM','STUDIO','OTHER')),
  room_type text NOT NULL DEFAULT 'ENTIRE' CHECK (room_type IN ('ENTIRE','PRIVATE_ROOM','SHARED_ROOM')),
  max_guests integer NOT NULL DEFAULT 2 CHECK (max_guests BETWEEN 1 AND 50),
  bedrooms integer NOT NULL DEFAULT 1 CHECK (bedrooms >= 0),
  beds integer NOT NULL DEFAULT 1 CHECK (beds >= 0),
  bathrooms numeric(3,1) NOT NULL DEFAULT 1 CHECK (bathrooms >= 0),
  lat numeric(9,6) CHECK (lat BETWEEN -90 AND 90),
  lng numeric(9,6) CHECK (lng BETWEEN -180 AND 180),
  country char(2) NOT NULL DEFAULT 'KR',
  region text,
  city text,
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  rental_enabled boolean NOT NULL DEFAULT false,
  exchange_enabled boolean NOT NULL DEFAULT false,
  instant_book boolean NOT NULL DEFAULT false,
  base_price_minor bigint CHECK (base_price_minor IS NULL OR base_price_minor >= 0),
  cleaning_fee_minor bigint NOT NULL DEFAULT 0 CHECK (cleaning_fee_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'KRW',
  min_nights integer NOT NULL DEFAULT 1 CHECK (min_nights >= 1),
  max_nights integer NOT NULL DEFAULT 90 CHECK (max_nights >= 1),
  check_in_time time NOT NULL DEFAULT '15:00',
  check_out_time time NOT NULL DEFAULT '11:00',
  cancellation_policy_id uuid REFERENCES cancellation_policies(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','PUBLISHED','UNLISTED','BLOCKED','ARCHIVED')),
  paid_booking_enabled boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_nights >= min_nights)
);
CREATE INDEX idx_properties_host ON properties(host_id);
CREATE INDEX idx_properties_public ON properties(status, city) WHERE status = 'PUBLISHED';
CREATE INDEX idx_properties_geo ON properties(lat, lng) WHERE status = 'PUBLISHED';
CREATE TRIGGER properties_touch BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

CREATE TABLE property_addresses (
  property_id uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  line1 text NOT NULL,
  line2 text,
  postal_code text,
  city text,
  region text,
  country char(2) NOT NULL DEFAULT 'KR',
  -- exact address is private until confirmed booking/exchange
  public_area_label text
);
CREATE TABLE amenities (
  code text PRIMARY KEY,
  category text NOT NULL,
  label_ko text NOT NULL,
  label_en text NOT NULL
);
CREATE TABLE property_amenities (
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  amenity_code text NOT NULL REFERENCES amenities(code),
  PRIMARY KEY (property_id, amenity_code)
);
CREATE TABLE house_rules (
  property_id uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  smoking_allowed boolean NOT NULL DEFAULT false,
  pets_allowed boolean NOT NULL DEFAULT false,
  events_allowed boolean NOT NULL DEFAULT false,
  quiet_hours text,
  extra_rules text
);
CREATE TABLE property_media (
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets(id),
  sort_order integer NOT NULL DEFAULT 0,
  caption text,
  PRIMARY KEY (property_id, media_id)
);

-- STAY-03 compliance
CREATE TABLE property_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  permit_type text NOT NULL,
  permit_no text,
  jurisdiction text NOT NULL,
  document_media_id uuid REFERENCES media_assets(id),
  valid_from date,
  valid_until date,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED')),
  reviewer_id uuid,
  decision_reason text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE INDEX idx_permits_property ON property_permits(property_id, status);
-- Effective-dated, approval-required jurisdiction rules (invariant 8: no hard-coded legal rule).
CREATE TABLE compliance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('PROPERTY','GUIDE','SUPPLIER','CHARTER')),
  jurisdiction text NOT NULL,           -- e.g. 'KR', 'KR-11' (Seoul), '*'
  applies_to jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"property_type":["HOUSE"],"room_type":["ENTIRE"]}
  required_permit_types text[] NOT NULL DEFAULT '{}',
  guest_eligibility jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"foreigners_only": true}
  effective_from date NOT NULL,
  effective_until date,
  approved_by uuid,
  approved_at timestamptz,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_compliance_rules_lookup ON compliance_rules(subject_type, jurisdiction, status);
CREATE TABLE compliance_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ALLOW','DENY','REVIEW')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules_evaluated jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluated_by text NOT NULL DEFAULT 'SYSTEM'
);
CREATE INDEX idx_compliance_decisions_subject ON compliance_decisions(subject_type, subject_id, evaluated_at DESC);

-- STAY-04 / PLAT-01 search projection state
CREATE TABLE search_sync_state (
  index_name text NOT NULL,
  document_id text NOT NULL,
  source_version timestamptz NOT NULL,
  synced_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SYNCED','DELETED','FAILED')),
  error text,
  PRIMARY KEY (index_name, document_id)
);

-- STAY-05 favorites
CREATE TABLE favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('PROPERTY','GUIDE','TRAVEL_PRODUCT')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','LINK','PUBLIC')),
  share_token text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collection_items (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  note text,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, target_type, target_id)
);

-- STAY-06 availability
CREATE TABLE availability_days (
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  day date NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','UNAVAILABLE')),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  min_nights integer CHECK (min_nights IS NULL OR min_nights >= 1),
  note text,
  PRIMARY KEY (property_id, day)
);
-- Authoritative occupancy: paid stay holds/reservations, exchanges and host blocks share one exclusion constraint.
CREATE TABLE inventory_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  stay_range daterange NOT NULL CHECK (NOT isempty(stay_range) AND lower_inc(stay_range) AND NOT upper_inc(stay_range)),
  block_type text NOT NULL CHECK (block_type IN ('HOLD','RESERVATION','EXCHANGE','HOST_BLOCK','EXTERNAL')),
  source_type text NOT NULL CHECK (source_type IN ('RESERVATION_HOLD','RESERVATION','EXCHANGE','HOST','INTEGRATION')),
  source_id uuid,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
  expires_at timestamptz,
  created_by uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
ALTER TABLE inventory_blocks ADD CONSTRAINT no_overlapping_active_property_blocks
  EXCLUDE USING gist (property_id WITH =, stay_range WITH &&) WHERE (state = 'ACTIVE');
CREATE INDEX idx_inventory_blocks_property ON inventory_blocks(property_id) WHERE state = 'ACTIVE';
CREATE INDEX idx_inventory_blocks_source ON inventory_blocks(source_type, source_id);
CREATE INDEX idx_inventory_blocks_expiry ON inventory_blocks(expires_at) WHERE state = 'ACTIVE' AND expires_at IS NOT NULL;

-- STAY-07 pricing
CREATE TABLE rate_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('WEEKEND','WEEKLY_DISCOUNT','MONTHLY_DISCOUNT','SEASON','EXTRA_GUEST')),
  params jsonb NOT NULL,
  valid_from date,
  valid_until date,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE booking_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid NOT NULL REFERENCES users(id),
  check_in date NOT NULL,
  check_out date NOT NULL,
  guests integer NOT NULL CHECK (guests >= 1),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  cleaning_fee_minor bigint NOT NULL DEFAULT 0,
  platform_fee_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL,
  breakdown jsonb NOT NULL,
  rules_version jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE TRIGGER booking_quotes_immutable BEFORE UPDATE ON booking_quotes FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();

-- STAY-08 hold
CREATE TABLE reservation_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES booking_quotes(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  inventory_block_id uuid NOT NULL REFERENCES inventory_blocks(id),
  guest_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONVERTED','RELEASED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_hold_quote_active ON reservation_holds(quote_id) WHERE status IN ('ACTIVE','CONVERTED');

-- STAY-09 reservation FSM
CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
  property_id uuid NOT NULL REFERENCES properties(id),
  host_id uuid NOT NULL REFERENCES users(id),
  guest_id uuid NOT NULL REFERENCES users(id),
  hold_id uuid REFERENCES reservation_holds(id),
  quote_id uuid REFERENCES booking_quotes(id),
  inventory_block_id uuid REFERENCES inventory_blocks(id),
  status text NOT NULL CHECK (status IN ('DRAFT','QUOTED','HELD','PAYMENT_PENDING','PAYMENT_FAILED','EXPIRED','CONFIRMED','CHECKED_IN','COMPLETED','CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','NO_SHOW','DISPUTED')),
  check_in date NOT NULL,
  check_out date NOT NULL,
  guests integer NOT NULL DEFAULT 1,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency char(3) NOT NULL,
  quote_snapshot jsonb NOT NULL,
  cancellation_policy_snapshot jsonb,
  guest_message text,
  cancelled_at timestamptz,
  cancel_reason text,
  confirmed_at timestamptz,
  checked_in_at timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in),
  CHECK (refunded_minor <= total_minor)
);
CREATE INDEX idx_reservations_guest ON reservations(guest_id, created_at DESC);
CREATE INDEX idx_reservations_host ON reservations(host_id, check_in);
CREATE INDEX idx_reservations_property ON reservations(property_id, check_in);
CREATE TRIGGER reservations_touch BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

-- Generic FSM history table used by all domains (actor, reason, correlation id — STAY-09 acceptance).
CREATE TABLE state_transitions (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL,
  actor_id uuid,
  actor_type text NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','ADMIN','SYSTEM','PROVIDER')),
  reason text,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_state_transitions_agg ON state_transitions(aggregate_type, aggregate_id, id);
CREATE TRIGGER state_transitions_append_only BEFORE UPDATE OR DELETE ON state_transitions FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
CREATE VIEW reservation_state_history AS
  SELECT * FROM state_transitions WHERE aggregate_type = 'RESERVATION';

-- STAY-10
CREATE TABLE reservation_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('CANCELLATION_REFUND','NO_SHOW','GOODWILL','DAMAGE','HOST_CANCELLATION_PENALTY')),
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  policy_evaluation jsonb NOT NULL DEFAULT '{}'::jsonb,
  refund_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
