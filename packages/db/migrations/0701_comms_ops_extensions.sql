-- 0701 COMMS-01 message metadata (contact-info masking notice), PLAT-06 config approval, OPS-03 redirects, INT-01, MIG-01.
ALTER TABLE messages ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX idx_messages_conversation_keyset ON messages(conversation_id, created_at DESC, id DESC);

-- PLAT-06: four-eyes approval of effective-dated config values
ALTER TABLE config_values ADD COLUMN proposed_by uuid, ADD COLUMN approved_at timestamptz;

ALTER TABLE seo_redirects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN source text;

-- INT-01: iCal export tokens (hash only) per property
CREATE TABLE ical_export_tokens (
  property_id uuid PRIMARY KEY REFERENCES properties(id),
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_integration_events_account ON integration_events(account_id, created_at DESC);
CREATE INDEX idx_integration_accounts_owner ON integration_accounts(owner_id);

-- MIG-01: imported users whose legacy password hash is not compatible must reset their password
CREATE TABLE migration_user_flags (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  source text NOT NULL,
  legacy_id text NOT NULL,
  requires_password_reset boolean NOT NULL,
  legacy_password_format text,
  batch_id uuid REFERENCES migration_batches(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
