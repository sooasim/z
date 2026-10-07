-- 0200 STAY-01..05 / PLAT-01 catalog extensions (Agent B, stay range 0200-0299). Forward-only.

-- STAY-03: four-eyes approval of compliance rules (creator cannot approve their own rule).
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS retired_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_compliance_rules_effective ON compliance_rules(subject_type, status, effective_from);
CREATE INDEX IF NOT EXISTS idx_permits_expiry ON property_permits(valid_until) WHERE status = 'VERIFIED';

-- STAY-01: public detail lookups.
CREATE INDEX IF NOT EXISTS idx_property_media_order ON property_media(property_id, sort_order);

-- PLAT-01 / STAY-04: PostgreSQL search projection (fallback adapter when Meilisearch is not configured).
-- This is a PROJECTION of properties (invariant 1); it is rebuildable from source tables at any time and
-- never authoritative for availability. Coordinates stored here are already privacy-fuzzed.
CREATE TABLE search_documents (
  index_name text NOT NULL,
  document_id text NOT NULL,
  property_id uuid,
  doc jsonb NOT NULL,
  search_text text NOT NULL DEFAULT '',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  city text,
  region text,
  country char(2),
  property_type text,
  room_type text,
  amenities text[] NOT NULL DEFAULT '{}',
  max_guests integer,
  price_minor bigint,
  currency char(3),
  rental_enabled boolean NOT NULL DEFAULT false,
  paid_booking_enabled boolean NOT NULL DEFAULT false,
  exchange_enabled boolean NOT NULL DEFAULT false,
  min_nights integer,
  max_nights integer,
  lat double precision,
  lng double precision,
  rating_avg numeric(3,2),
  review_count integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_name, document_id)
);
CREATE INDEX idx_search_documents_tsv ON search_documents USING gin(tsv);
CREATE INDEX idx_search_documents_amenities ON search_documents USING gin(amenities);
CREATE INDEX idx_search_documents_geo ON search_documents(index_name, lat, lng);
CREATE INDEX idx_search_documents_city ON search_documents(index_name, city);
CREATE INDEX idx_search_documents_price ON search_documents(index_name, price_minor);
