-- 0002 CORE-01..04, TRUST-01..03, HOST-01
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE,
  phone text,
  password_hash text,
  display_name text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED','PENDING_DELETION','RESTRICTED')),
  locale text NOT NULL DEFAULT 'ko-KR',
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  identity_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

CREATE TABLE oauth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google','kakao','naver','apple')),
  provider_subject text NOT NULL,
  email citext,
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor_type text NOT NULL CHECK (factor_type IN ('TOTP')),
  secret_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED','VERIFIED','REVOKED')),
  recovery_codes_hash text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE UNIQUE INDEX uq_mfa_active ON mfa_factors(user_id, factor_type) WHERE status = 'VERIFIED';

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  aal text NOT NULL DEFAULT 'aal1' CHECK (aal IN ('aal1','aal2')),
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('EMAIL_OTP','PASSWORD_RESET','EMAIL_VERIFY','OAUTH_STATE','ACCOUNT_LINK')),
  subject text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_challenges_subject ON auth_challenges(purpose, subject, created_at DESC);

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_name text,
  preferred_name text,
  bio text,
  avatar_media_id uuid,
  birth_year integer CHECK (birth_year BETWEEN 1900 AND 2100),
  country char(2),
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  languages text[] NOT NULL DEFAULT '{}',
  accessibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency char(3) NOT NULL DEFAULT 'KRW',
  travel_styles text[] NOT NULL DEFAULT '{}',
  interests text[] NOT NULL DEFAULT '{}',
  personalization_opt_out boolean NOT NULL DEFAULT false,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_touch BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION jp_touch_updated_at();

-- CORE-03 RBAC
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('USER','HOST','GUIDE','SUPPLIER','ADMIN','ACCOUNTING','SUPPORT','EDITOR','COMPLIANCE')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
CREATE TABLE role_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  action text NOT NULL CHECK (action IN ('GRANT','REVOKE')),
  actor_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE policy_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  permission text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  reason text NOT NULL,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- CORE-04 consent & privacy
CREATE TABLE consent_documents (
  consent_type text NOT NULL CHECK (consent_type IN ('TERMS','PRIVACY','MARKETING','LOCATION','THIRD_PARTY','EXCHANGE_TERMS','GUIDE_TERMS','REFUND_POLICY')),
  version text NOT NULL,
  title text NOT NULL,
  body_md text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  published_at timestamptz,
  PRIMARY KEY (consent_type, version)
);
CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  consent_type text NOT NULL,
  version text NOT NULL,
  granted boolean NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_user ON consent_records(user_id, consent_type, created_at DESC);
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();

CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  request_type text NOT NULL CHECK (request_type IN ('EXPORT','DELETE','RESTRICT')),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','COMPLETED','REJECTED')),
  result_location text,
  result jsonb,
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE retention_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_class text NOT NULL,
  retention_days integer NOT NULL,
  last_run_at timestamptz,
  last_result jsonb
);

-- TRUST-01 verification
CREATE TABLE business_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  business_type text NOT NULL CHECK (business_type IN ('INDIVIDUAL','SOLE_PROPRIETOR','CORPORATION')),
  business_name text,
  registration_no text,
  representative text,
  address text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE verification_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  subject_type text NOT NULL CHECK (subject_type IN ('IDENTITY','HOST','GUIDE','SUPPLIER','BUSINESS','PAYOUT_ACCOUNT','PROPERTY')),
  subject_id uuid,
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('DRAFT','SUBMITTED','IN_REVIEW','APPROVED','REJECTED','EXPIRED')),
  reviewer_id uuid,
  decision_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX idx_verification_user ON verification_cases(user_id, subject_type);
CREATE INDEX idx_verification_queue ON verification_cases(status, submitted_at) WHERE status IN ('SUBMITTED','IN_REVIEW');
CREATE TABLE verification_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification_cases(id),
  document_type text NOT NULL,
  media_id uuid,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- HOST-01
CREATE TABLE host_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  display_name text,
  about text,
  verification_status text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  status text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','APPROVED','REJECTED','SUSPENDED')),
  payout_profile_id uuid,
  response_rate numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE host_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','IN_REVIEW','APPROVED','REJECTED','WITHDRAWN')),
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewer_id uuid,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX uq_host_application_open ON host_applications(user_id) WHERE status IN ('SUBMITTED','IN_REVIEW');

-- TRUST-02 reviews
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('PROPERTY','HOST','GUEST','EXCHANGE_PARTNER','GUIDE','TRAVELER','TRAVEL_PRODUCT')),
  target_id uuid NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('RESERVATION','EXCHANGE','GUIDE_BOOKING','ORDER')),
  transaction_id uuid NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  sub_ratings jsonb NOT NULL DEFAULT '{}'::jsonb,
  body text,
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PENDING','PUBLISHED','HIDDEN','REMOVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, transaction_type, transaction_id, target_type, target_id)
);
CREATE INDEX idx_reviews_target ON reviews(target_type, target_id, created_at DESC);
CREATE TABLE review_responses (
  review_id uuid PRIMARY KEY REFERENCES reviews(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE review_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES reviews(id),
  reporter_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UPHELD','DISMISSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, reporter_id)
);
CREATE TABLE reputation_scores (
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  review_count integer NOT NULL DEFAULT 0,
  rating_avg numeric(3,2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_type, target_id)
);

-- TRUST-03 disputes / safety
CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by uuid NOT NULL REFERENCES users(id),
  context_type text NOT NULL CHECK (context_type IN ('RESERVATION','EXCHANGE','GUIDE_BOOKING','ORDER','MESSAGE','REVIEW','OTHER')),
  context_id uuid NOT NULL,
  counterparty_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','AWAITING_PARTY','RESOLVED','REJECTED','ESCALATED')),
  severity text NOT NULL DEFAULT 'NORMAL' CHECK (severity IN ('LOW','NORMAL','HIGH','CRITICAL')),
  reason text NOT NULL,
  description text,
  assignee_id uuid REFERENCES users(id),
  resolution text,
  resolution_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX idx_disputes_queue ON disputes(status, created_at);
CREATE TABLE dispute_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  submitted_by uuid NOT NULL REFERENCES users(id),
  evidence_type text NOT NULL CHECK (evidence_type IN ('TEXT','MEDIA','MESSAGE_REF','DOCUMENT')),
  content text,
  media_id uuid,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER dispute_evidence_append_only BEFORE UPDATE OR DELETE ON dispute_evidence FOR EACH ROW EXECUTE FUNCTION jp_reject_mutation();
CREATE TABLE dispute_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  actor_id uuid,
  event_type text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE safety_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  category text NOT NULL,
  description text,
  urgent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','TRIAGED','ACTIONED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sanctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  sanction_type text NOT NULL CHECK (sanction_type IN ('WARNING','LISTING_SUSPENSION','PAYOUT_HOLD','ACCOUNT_SUSPENSION','BAN')),
  reason text NOT NULL,
  dispute_id uuid REFERENCES disputes(id),
  issued_by uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  lifted_at timestamptz
);
-- Case-scoped, time-limited, audited elevation for private message access (invariant 10).
CREATE TABLE elevated_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES users(id),
  case_type text NOT NULL CHECK (case_type IN ('DISPUTE','SAFETY_REPORT','SUPPORT_CASE')),
  case_id uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('CONVERSATION')),
  resource_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 10),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at <= created_at + interval '24 hours')
);
CREATE INDEX idx_elevated_admin ON elevated_access_grants(admin_id, resource_type, resource_id);
