-- 0800 platform/infra gap closure:
--   PLAT-03 dead_letters view · PLAT-06 config version history (feature_flags + config_values) ·
--   PLAT-05 security/risk: risk_events, risk_signals, risk_scan_cursors, security_incidents (+ timeline).

-- ------------------------------------------------------------------------------------------------ PLAT-03
-- Operator view over outbox events that exhausted their retries (admin retry clears dead_lettered_at).
CREATE VIEW dead_letters AS
  SELECT id, aggregate_type, aggregate_id, event_type, attempts, last_error, dead_lettered_at, correlation_id, payload
    FROM outbox_events
   WHERE dead_lettered_at IS NOT NULL;
CREATE INDEX idx_outbox_dead_lettered ON outbox_events(dead_lettered_at DESC) WHERE dead_lettered_at IS NOT NULL;

-- ------------------------------------------------------------------------------------------------ PLAT-06
-- Append-only history of every feature flag / config value change, written by triggers (no code path can skip it).
-- `reason` comes from the transaction-local setting jetpool.change_reason (SELECT set_config('jetpool.change_reason', $1, true)).
CREATE TABLE config_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config_type text NOT NULL CHECK (config_type IN ('FLAG','CONFIG')),
  config_key text NOT NULL,
  before jsonb,
  after jsonb,
  changed_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_config_versions_key ON config_versions(config_type, config_key, id DESC);
CREATE INDEX idx_config_versions_created ON config_versions(created_at DESC);
CREATE TRIGGER config_versions_append_only BEFORE UPDATE OR DELETE ON config_versions FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();

CREATE OR REPLACE FUNCTION jp_change_reason() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('jetpool.change_reason', true), '')
$$;

CREATE OR REPLACE FUNCTION jp_version_feature_flag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'flag_key' - 'updated_at' - 'updated_by' END;
  a jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'flag_key' - 'updated_at' - 'updated_by' END;
BEGIN
  IF TG_OP = 'UPDATE' AND b IS NOT DISTINCT FROM a THEN RETURN NULL; END IF; -- touch-only upsert: no new version
  INSERT INTO config_versions(config_type, config_key, before, after, changed_by, reason)
  VALUES ('FLAG', CASE WHEN TG_OP = 'DELETE' THEN OLD.flag_key ELSE NEW.flag_key END, b, a,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.updated_by END, jp_change_reason());
  RETURN NULL;
END $$;
CREATE TRIGGER feature_flags_versioned AFTER INSERT OR UPDATE OR DELETE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION jp_version_feature_flag();

CREATE OR REPLACE FUNCTION jp_version_config_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  a jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
BEGIN
  IF TG_OP = 'UPDATE' AND b IS NOT DISTINCT FROM a THEN RETURN NULL; END IF;
  INSERT INTO config_versions(config_type, config_key, before, after, changed_by, reason)
  VALUES ('CONFIG', CASE WHEN TG_OP = 'DELETE' THEN OLD.config_key ELSE NEW.config_key END, b, a,
          CASE TG_OP WHEN 'INSERT' THEN coalesce(NEW.proposed_by, NEW.approved_by)
                     WHEN 'UPDATE' THEN coalesce(NEW.approved_by, NEW.proposed_by) END,
          coalesce(jp_change_reason(), CASE WHEN TG_OP <> 'DELETE' THEN NEW.note END));
  RETURN NULL;
END $$;
CREATE TRIGGER config_values_versioned AFTER INSERT OR UPDATE OR DELETE ON config_values
  FOR EACH ROW EXECUTE FUNCTION jp_version_config_value();

-- baseline: the state at the time history starts
INSERT INTO config_versions(config_type, config_key, before, after, changed_by, reason)
  SELECT 'FLAG', f.flag_key, NULL, to_jsonb(f) - 'flag_key' - 'updated_at' - 'updated_by', f.updated_by, 'baseline (migration 0800)'
    FROM feature_flags f ORDER BY f.flag_key;
INSERT INTO config_versions(config_type, config_key, before, after, changed_by, reason)
  SELECT 'CONFIG', c.config_key, NULL, to_jsonb(c), coalesce(c.approved_by, c.proposed_by), 'baseline (migration 0800)'
    FROM config_values c ORDER BY c.config_key, c.effective_from;

-- ------------------------------------------------------------------------------------------------ PLAT-05
-- Risk events: detections (automatic consumers / sweeps) and manual staff flags. Status changes go through the
-- RISK_EVENT state machine (state_transitions).
CREATE TABLE risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('USER','IP','PROPERTY','PAYMENT','MEDIA','DEVICE')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  risk_type text NOT NULL CHECK (risk_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','FALSE_POSITIVE')),
  -- replay/burst dedupe (e.g. 'CARD_TESTING:USER:<id>:<10-min bucket>'); NULL = no dedupe
  dedupe_key text UNIQUE,
  source_event_id uuid,
  correlation_id text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  CHECK ((status IN ('RESOLVED','FALSE_POSITIVE')) = (resolved_at IS NOT NULL))
);
CREATE INDEX idx_risk_events_subject ON risk_events(subject_type, subject_id, created_at DESC);
CREATE INDEX idx_risk_events_list ON risk_events(created_at DESC, id DESC);
CREATE INDEX idx_risk_events_open ON risk_events(severity, created_at DESC) WHERE status IN ('OPEN','ACKNOWLEDGED');
CREATE TRIGGER risk_events_touch BEFORE UPDATE ON risk_events FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

-- Raw signals used for burst detection (e.g. payment failures per payer). One row per source event (idempotent).
CREATE TABLE risk_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  source_event_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_type, source_event_id)
);
CREATE INDEX idx_risk_signals_window ON risk_signals(signal_type, subject_type, subject_id, occurred_at DESC);

-- Watermarks of incremental sweeps over append-only sources (e.g. state_transitions for media rejections).
CREATE TABLE risk_scan_cursors (
  scanner text PRIMARY KEY,
  last_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Security incidents (incident response). Status changes go through the SECURITY_INCIDENT state machine.
CREATE TABLE security_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  severity text NOT NULL CHECK (severity IN ('SEV1','SEV2','SEV3','SEV4')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','MITIGATED','RESOLVED','POSTMORTEM_DONE')),
  summary text CHECK (summary IS NULL OR length(summary) <= 10000),
  commander_id uuid REFERENCES users(id),
  related_risk_event_ids uuid[] NOT NULL DEFAULT '{}',
  opened_by uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  mitigated_at timestamptz,
  resolved_at timestamptz,
  postmortem_url text CHECK (postmortem_url IS NULL OR (postmortem_url ~ '^https://' AND length(postmortem_url) <= 2000)),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'POSTMORTEM_DONE' OR postmortem_url IS NOT NULL),
  CHECK (status NOT IN ('RESOLVED','POSTMORTEM_DONE') OR resolved_at IS NOT NULL)
);
CREATE INDEX idx_security_incidents_list ON security_incidents(opened_at DESC, id DESC);
CREATE INDEX idx_security_incidents_active ON security_incidents(severity, opened_at DESC) WHERE status NOT IN ('RESOLVED','POSTMORTEM_DONE');
CREATE TRIGGER security_incidents_touch BEFORE UPDATE ON security_incidents FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

-- Incident timeline (append-only).
CREATE TABLE security_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES security_incidents(id),
  event_type text NOT NULL CHECK (event_type IN ('OPENED','NOTE','STATUS_CHANGE','SEVERITY_CHANGE','COMMANDER_CHANGE','RISK_LINKED')),
  from_status text,
  to_status text,
  note text CHECK (note IS NULL OR length(note) <= 10000),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id),
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_security_incident_events ON security_incident_events(incident_id, created_at, id);
CREATE TRIGGER security_incident_events_append_only BEFORE UPDATE OR DELETE ON security_incident_events
  FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
