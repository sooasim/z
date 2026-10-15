-- 0603 TRAVEL-01: the platform's own supplier record ("house" supplier). Forward-only.
--
-- Until now every travel product belonged to a third-party supplier whose owner signed in to the supplier
-- extranet, so head office could review and publish a product but could not author one: there was no
-- suppliers row for JETPOOL itself to hang products on. This column marks that one row, so the console can
-- create and edit in-house products through the same tables, FSM and review flow as everyone else — the
-- catalogue, orders and the ledger stay a single code path.
--
-- Merchant of record is a legal/commercial decision per supplier (invariant 8), and for an in-house product
-- the platform IS the seller: the row is created with merchant_of_record = 'JETPOOL'. A third-party supplier
-- keeps whatever its own G9 approval set.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_house boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN suppliers.is_house IS
  'True for the single JETPOOL-operated supplier that in-house travel products belong to. Owned by the company, not a user (owner_user_id IS NULL), so no person inherits the SUPPLIER role from it.';

-- At most one house supplier, enforced by the database rather than by whoever writes the next helper.
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_single_house ON suppliers (is_house) WHERE is_house;
