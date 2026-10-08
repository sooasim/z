-- 0951 trust hardening r1 (OPS-01): the external desk (Chatwoot) mirror no longer runs inside the outbox dispatch
-- transaction. The outbox consumer only marks the case as due; a job claims due cases (SKIP LOCKED lease),
-- calls the desk outside any transaction and stores external_ref with a compare-and-set.
ALTER TABLE support_cases
  ADD COLUMN desk_sync_due_at timestamptz,
  ADD COLUMN desk_sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN desk_sync_error text;
CREATE INDEX idx_support_cases_desk_sync_due ON support_cases(desk_sync_due_at) WHERE desk_sync_due_at IS NOT NULL;
