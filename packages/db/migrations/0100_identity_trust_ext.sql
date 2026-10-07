-- 0100 CORE-01..04, TRUST-01..03, HOST-01, OPS-01 extensions (Agent A). Forward-only.

-- CORE-01 brute-force protection (per-account attempt counting + exponential lockout)
ALTER TABLE users
  ADD COLUMN failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN failed_mfa_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

-- CORE-01 refresh-token rotation with reuse detection. Every rotated (superseded) refresh token hash is
-- kept here; presenting one again means the token leaked -> the whole session family is revoked.
ALTER TABLE sessions
  ADD COLUMN revoke_reason text,
  ADD COLUMN rotation_counter integer NOT NULL DEFAULT 0,
  ADD COLUMN auth_method text NOT NULL DEFAULT 'PASSWORD'
    CHECK (auth_method IN ('PASSWORD','EMAIL_OTP','OAUTH','PASSWORD_RESET','TEST')),
  ADD COLUMN aal2_at timestamptz;
CREATE TABLE session_refresh_history (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  rotated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_refresh_history_session ON session_refresh_history(session_id);

-- TOTP replay protection: the last accepted time-step counter
ALTER TABLE mfa_factors ADD COLUMN last_used_counter bigint;

-- TRUST-02 moderation metadata
ALTER TABLE reviews
  ADD COLUMN moderation_reason text,
  ADD COLUMN moderated_by uuid REFERENCES users(id),
  ADD COLUMN moderated_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_reviews_author ON reviews(author_id, created_at DESC);
CREATE INDEX idx_reviews_transaction ON reviews(transaction_type, transaction_id);

-- TRUST-03 sanction lifting + dispute timeline visibility
ALTER TABLE sanctions
  ADD COLUMN lifted_by uuid REFERENCES users(id),
  ADD COLUMN lift_reason text;
CREATE INDEX idx_sanctions_user_active ON sanctions(user_id) WHERE lifted_at IS NULL;
ALTER TABLE dispute_events ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE INDEX idx_dispute_events_dispute ON dispute_events(dispute_id, created_at);
CREATE INDEX idx_disputes_parties ON disputes(opened_by, created_at DESC);
CREATE INDEX idx_disputes_counterparty ON disputes(counterparty_id, created_at DESC);
ALTER TABLE safety_reports ADD COLUMN assignee_id uuid REFERENCES users(id), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- TRUST-01 verification documents are evidence: append-only
CREATE TRIGGER verification_documents_append_only BEFORE UPDATE OR DELETE ON verification_documents FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
CREATE UNIQUE INDEX uq_verification_open ON verification_cases(user_id, subject_type, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('SUBMITTED','IN_REVIEW');
ALTER TABLE business_profiles ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- OPS-01 support
CREATE INDEX idx_support_requester ON support_cases(requester_id, created_at DESC);
CREATE INDEX idx_support_case_events_case ON support_case_events(case_id, created_at);

-- CORE-04
CREATE INDEX idx_privacy_requests_user ON privacy_requests(user_id, requested_at DESC);
CREATE INDEX idx_role_grants_user ON role_grants(user_id, created_at DESC);
CREATE INDEX idx_policy_overrides_user ON policy_overrides(user_id, permission);
