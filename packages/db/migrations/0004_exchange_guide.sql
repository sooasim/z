-- 0004 EXCH-01..06 (independent FSM — never merged into reservations) and GUIDE-01..05
CREATE TABLE exchange_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  status text NOT NULL DEFAULT 'INCOMPLETE' CHECK (status IN ('INCOMPLETE','ELIGIBLE','SUSPENDED')),
  home_description text,
  preferred_destinations text[] NOT NULL DEFAULT '{}',
  flexible_dates boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exchange_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id),
  responder_id uuid NOT NULL REFERENCES users(id),
  property_a_id uuid NOT NULL REFERENCES properties(id), -- requester's home
  property_b_id uuid NOT NULL REFERENCES properties(id), -- responder's home
  dates_a daterange NOT NULL,  -- when B's party stays at A
  dates_b daterange NOT NULL,  -- when A's party stays at B
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','COUNTERED','MUTUAL_ACCEPTED','VERIFICATION_PENDING','AGREEMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED','DECLINED','WITHDRAWN','EXPIRED','DISPUTED','CANCELLED')),
  current_offer_version integer NOT NULL DEFAULT 1,
  last_offer_by uuid REFERENCES users(id),
  accepted_a_version integer,
  accepted_b_version integer,
  conversation_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_id <> responder_id),
  CHECK (property_a_id <> property_b_id)
);
CREATE INDEX idx_exchange_requester ON exchange_requests(requester_id, created_at DESC);
CREATE INDEX idx_exchange_responder ON exchange_requests(responder_id, created_at DESC);
CREATE TRIGGER exchange_requests_touch BEFORE UPDATE ON exchange_requests FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
CREATE TABLE exchange_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL REFERENCES exchange_requests(id),
  version integer NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  dates_a daterange NOT NULL,
  dates_b daterange NOT NULL,
  guests_a integer NOT NULL DEFAULT 1,
  guests_b integer NOT NULL DEFAULT 1,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_id, version)
);
CREATE TRIGGER exchange_offers_append_only BEFORE UPDATE OR DELETE ON exchange_offers FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
CREATE TABLE exchange_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL REFERENCES exchange_requests(id),
  party_user_id uuid NOT NULL REFERENCES users(id),
  check_type text NOT NULL CHECK (check_type IN ('IDENTITY','PROPERTY','SAFETY_ACK')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PASSED','FAILED')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz,
  UNIQUE (exchange_id, party_user_id, check_type)
);
CREATE TABLE exchange_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL UNIQUE REFERENCES exchange_requests(id),
  terms_version text NOT NULL,
  terms_snapshot jsonb NOT NULL,
  terms_hash text NOT NULL,
  offer_version integer NOT NULL,
  accepted_a_at timestamptz,
  accepted_a_evidence jsonb,
  accepted_b_at timestamptz,
  accepted_b_evidence jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PARTIALLY_SIGNED','SIGNED','VOID')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- GUIDE
CREATE TABLE guide_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  guide_type text NOT NULL CHECK (guide_type IN ('FRIEND','VOLUNTEER','PAID','PROFESSIONAL')),
  headline text,
  bio text,
  languages text[] NOT NULL DEFAULT '{}',
  regions text[] NOT NULL DEFAULT '{}',
  interests text[] NOT NULL DEFAULT '{}',
  specialties text[] NOT NULL DEFAULT '{}',
  lat numeric(9,6), lng numeric(9,6),
  city text,
  verification_status text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  paid_enabled boolean NOT NULL DEFAULT false,
  hourly_price_minor bigint CHECK (hourly_price_minor IS NULL OR hourly_price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'KRW',
  max_group_size integer NOT NULL DEFAULT 4,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','HIDDEN','SUSPENDED')),
  rating_avg numeric(3,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- FRIEND/VOLUNTEER are free by policy
  CHECK (guide_type IN ('PAID','PROFESSIONAL') OR (paid_enabled = false))
);
CREATE TRIGGER guide_profiles_touch BEFORE UPDATE ON guide_profiles FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
CREATE TABLE guide_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid NOT NULL REFERENCES users(id),
  qualification_type text NOT NULL CHECK (qualification_type IN ('BUSINESS_REGISTRATION','GUIDE_LICENSE','INSURANCE','TRAVEL_AGENCY_REGISTRATION','OTHER')),
  reference_no text,
  document_media_id uuid,
  valid_until date,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED','EXPIRED')),
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guide_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid NOT NULL REFERENCES users(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','BLOCKED')),
  CHECK (end_at > start_at)
);
CREATE INDEX idx_guide_availability ON guide_availability(guide_id, start_at);
CREATE TABLE guide_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traveler_id uuid NOT NULL REFERENCES users(id),
  guide_id uuid REFERENCES users(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  city text,
  languages text[] NOT NULL DEFAULT '{}',
  interests text[] NOT NULL DEFAULT '{}',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','OFFERED','COUNTERED','ACCEPTED','DECLINED','CANCELLED','EXPIRED')),
  current_offer_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX idx_guide_requests_traveler ON guide_requests(traveler_id, created_at DESC);
CREATE INDEX idx_guide_requests_guide ON guide_requests(guide_id, status);
CREATE TABLE guide_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES guide_requests(id),
  version integer NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  paid boolean NOT NULL,
  price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'KRW',
  itinerary text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SUPERSEDED','ACCEPTED','DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, version),
  CHECK (paid OR price_minor = 0)
);
CREATE TABLE guide_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid REFERENCES guide_requests(id),
  offer_id uuid REFERENCES guide_offers(id),
  guide_id uuid NOT NULL REFERENCES users(id),
  traveler_id uuid NOT NULL REFERENCES users(id),
  guide_type text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ACCEPTED','PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED','CANCELLED','DISPUTED','PAYMENT_FAILED')),
  paid boolean NOT NULL DEFAULT false,
  price_minor bigint NOT NULL DEFAULT 0,
  refunded_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'KRW',
  conversation_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (paid OR price_minor = 0)
);
-- A guide cannot be double-booked.
ALTER TABLE guide_bookings ADD CONSTRAINT no_overlapping_guide_bookings
  EXCLUDE USING gist (guide_id WITH =, tstzrange(start_at, end_at) WITH &&)
  WHERE (status IN ('ACCEPTED','PAYMENT_PENDING','CONFIRMED','IN_PROGRESS'));
CREATE INDEX idx_guide_bookings_traveler ON guide_bookings(traveler_id, start_at DESC);
CREATE TRIGGER guide_bookings_touch BEFORE UPDATE ON guide_bookings FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();
