-- QA hardening r1 — catalog group (STAY-01 properties, STAY-02 media, STAY-03 compliance, STAY-04/PLAT-01 search,
-- PLAT-02 geo). Forward-only.

-- 1) STAY-03: server-derived compliance jurisdiction. ISO 3166-2 codes geocoded from the stored address and
--    coordinates; evaluation UNIONS them with the host-declared country/region, so declaring another region can add
--    rules but never removes the rules of where the listing is. NULL = not computed yet (backfilled by a job).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_jurisdictions text[];
COMMENT ON COLUMN properties.geo_jurisdictions IS
  'Server-derived (geocoder) ISO 3166-2 jurisdictions of the listing location; unioned with country/region for compliance. NULL = not computed yet.';

-- 2) STAY-03: a verified permit is bound to the subject it was verified for (address, coordinates, jurisdiction,
--    property/room type). Moving the listing or changing its type requires a re-verified permit.
ALTER TABLE property_permits ADD COLUMN IF NOT EXISTS verified_subject jsonb;
COMMENT ON COLUMN property_permits.verified_subject IS
  'Snapshot of the listing (location + type) at verification; evaluation requires the current listing to still match.';
-- existing verified permits are bound to the listing as it is now (best available evidence)
UPDATE property_permits pp
   SET verified_subject = jsonb_build_object(
         'v', 1, 'country', p.country, 'region', p.region, 'propertyType', p.property_type, 'roomType', p.room_type,
         'lat', p.lat, 'lng', p.lng,
         'address', CASE WHEN a.property_id IS NULL THEN NULL ELSE jsonb_build_object(
           'line1', a.line1, 'line2', a.line2, 'postalCode', a.postal_code, 'city', a.city, 'region', a.region, 'country', a.country) END)
  FROM properties p LEFT JOIN property_addresses a ON a.property_id = p.id
 WHERE pp.property_id = p.id AND pp.status = 'VERIFIED' AND pp.verified_subject IS NULL;

-- 3) STAY-01: properties.timezone must be a zone PostgreSQL knows (`now() AT TIME ZONE p.timezone` runs in global
--    sweeps such as stay auto-completion; one bad row used to fail the whole batch). Repair, then enforce.
UPDATE properties SET timezone = CASE WHEN country = 'KR' THEN 'Asia/Seoul' ELSE 'UTC' END
 WHERE timezone NOT IN (SELECT name FROM pg_timezone_names);

CREATE OR REPLACE FUNCTION jp_properties_valid_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone "%"', NEW.timezone USING ERRCODE = 'check_violation', CONSTRAINT = 'properties_timezone_valid';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS properties_timezone_valid ON properties;
CREATE TRIGGER properties_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON properties
  FOR EACH ROW EXECUTE FUNCTION jp_properties_valid_timezone();

-- 4) STAY-02: processing lease, so an abandoned PROCESSING claim (crashed worker) can be released for retry.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_media_processing ON media_assets(processing_started_at) WHERE status = 'PROCESSING';

-- 5) PLAT-01/02: public coordinates are now fuzzed with a server-secret key (the old unkeyed offset was reversible).
--    Re-project every search document so no index keeps the old, reversible points (search.flush / reconcile).
UPDATE search_sync_state SET status = 'PENDING', error = NULL WHERE index_name = 'properties' AND status = 'SYNCED';
