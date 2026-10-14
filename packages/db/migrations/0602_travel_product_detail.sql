-- 0602 TRAVEL-01: structured programme detail on a travel product. Forward-only.
--
-- The migrated WON TRAVEL CLUB (wontc.co.kr) programmes carried their fact sheet, day-by-day schedule, destination
-- guide and hotel information as baked-in images. MIG-01 rebuilds that as data so the catalogue can render it as
-- text (and translate it per reader locale) instead of republishing screenshots. The column is editorial content
-- for the product page only: pricing, inventory and money stay in the typed columns and in travel_departures.
ALTER TABLE travel_products ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN travel_products.detail IS
  'Editorial programme detail rendered on the product page: {lead, factSheet, features[], highlights[], schedule{days[]}, spots[], stays[], companions[], route, destination, gallery[], documents[], legacy{}}. Never a source of price or availability.';

-- a migrated programme is readable even when it is no longer on sale (ARCHIVED): the public catalogue keeps the
-- heritage collection browsable, while ordering still requires PUBLISHED + an open departure.
CREATE INDEX IF NOT EXISTS idx_travel_products_legacy
  ON travel_products ((detail -> 'legacy' ->> 'system'))
  WHERE detail -> 'legacy' ->> 'system' IS NOT NULL;
