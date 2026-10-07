-- 0801 Ops gap closure: OPS-01 support_case_links, OPS-02 admin_saved_views, OPS-03 cms_external_refs + structured SEO.

-- OPS-02: per-staff saved console views (filters/columns/sort). Shared views are readable by all staff, editable by the owner.
CREATE TABLE admin_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  view_type text NOT NULL CHECK (view_type IN ('USERS','LISTINGS','RESERVATIONS','EXCHANGES','GUIDE_BOOKINGS','ORDERS','PAYMENTS','REFUNDS',
                                               'SETTLEMENTS','DISPUTES','COMPLIANCE','AUDIT','SUPPORT_CASES')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  columns text[] NOT NULL DEFAULT '{}',
  sort jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sort) = 'array'),
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, view_type, name)
);
CREATE INDEX idx_admin_saved_views_shared ON admin_saved_views(view_type, name) WHERE shared;
CREATE TRIGGER admin_saved_views_touch BEFORE UPDATE ON admin_saved_views FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

-- OPS-01: context links of a support case (requester's verified context + staff-added links).
CREATE TABLE support_case_links (
  case_id uuid NOT NULL REFERENCES support_cases(id),
  link_type text NOT NULL CHECK (link_type IN ('RESERVATION','EXCHANGE','GUIDE_BOOKING','ORDER','DISPUTE','PAYMENT','USER','CONVERSATION')),
  link_id uuid NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, link_type, link_id)
);
CREATE INDEX idx_support_case_links_target ON support_case_links(link_type, link_id);
-- external desk (Chatwoot) conversation reference: one case per external conversation
CREATE UNIQUE INDEX uq_support_cases_external_ref ON support_cases(external_ref) WHERE external_ref IS NOT NULL;

-- OPS-03: external CMS / legacy source references of a content entry (Payload sync, legacy WONT / SixShop migration).
CREATE TABLE cms_external_refs (
  entry_id uuid NOT NULL REFERENCES cms_entries(id),
  system text NOT NULL CHECK (system IN ('PAYLOAD','LEGACY_WONT','SIXSHOP')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 300),
  external_url text CHECK (external_url IS NULL OR length(external_url) <= 2000),
  -- source-side updatedAt of the last applied revision (out-of-order / replayed webhooks are ignored)
  source_updated_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, external_id),
  UNIQUE (entry_id, system)
);

-- OPS-03 structured content: seo is always a JSON object {title, description, canonical, noindex, og:{...}}
ALTER TABLE cms_entries ADD CONSTRAINT cms_entries_seo_object CHECK (jsonb_typeof(seo) = 'object') NOT VALID;
ALTER TABLE cms_entries ADD CONSTRAINT cms_entries_data_object CHECK (jsonb_typeof(data) = 'object') NOT VALID;
