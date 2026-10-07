-- JETPOOL v2 · 0001 platform primitives (PLAT-03, PLAT-06, OPS-04 audit, idempotency, webhooks)
-- PostgreSQL is the transaction Source of Truth (AGENTS_MASTER invariant 1).
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION jp_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION jp_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001'; END $$;

-- Transactional outbox (PLAT-03). Rows are written in the same tx as the state change.
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  correlation_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  dead_lettered_at timestamptz
);
CREATE INDEX idx_outbox_unpublished ON outbox_events(available_at) WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id, created_at);

-- Consumer-side dedupe so every handler is idempotent.
CREATE TABLE outbox_consumptions (
  consumer text NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Idempotency (invariant 4/5). scope = route + actor.
CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key)
);
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- External webhook replay protection.
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  signature_valid boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  process_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);

-- Audit log (append-only).
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_roles text[] NOT NULL DEFAULT '{}',
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id text,
  ip inet,
  user_agent text,
  category text NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('GENERAL','MONEY','PERMISSION','COMPLIANCE','ELEVATED_ACCESS','PRIVACY','SECURITY','CONTENT')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_category ON audit_logs(category, created_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();

-- Feature flags & config (PLAT-06). Critical features default OFF.
CREATE TABLE feature_flags (
  flag_key text PRIMARY KEY,
  description text,
  enabled boolean NOT NULL DEFAULT false,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE config_values (
  config_key text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  approved_by uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (config_key, effective_from)
);

-- Legacy migration (MIG-01)
CREATE TABLE migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  entity_type text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('DRY_RUN','APPLY')),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  source_file_hash text,
  source_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE migration_id_map (
  legacy_type text NOT NULL,
  legacy_id text NOT NULL,
  new_id uuid NOT NULL,
  batch_id uuid REFERENCES migration_batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (legacy_type, legacy_id)
);
CREATE TABLE migration_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES migration_batches(id),
  legacy_type text NOT NULL,
  legacy_id text,
  outcome text NOT NULL CHECK (outcome IN ('IMPORTED','SKIPPED','ERROR')),
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE seo_redirects (
  legacy_path text PRIMARY KEY,
  target_path text NOT NULL,
  status_code integer NOT NULL DEFAULT 301 CHECK (status_code IN (301,302,307,308)),
  approved boolean NOT NULL DEFAULT false,
  hits bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
