-- 0006 COMMS-01/02, OPS-01..04, AI-01/02, INT-01
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type text NOT NULL CHECK (context_type IN ('RESERVATION','EXCHANGE','GUIDE_REQUEST','GUIDE_BOOKING','ORDER','INQUIRY','SUPPORT')),
  context_id uuid,
  created_by uuid REFERENCES users(id),
  last_message_at timestamptz,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_conversation_context ON conversations(context_type, context_id) WHERE context_id IS NOT NULL AND context_type <> 'INQUIRY';
CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('GUEST','HOST','REQUESTER','RESPONDER','TRAVELER','GUIDE','BUYER','SUPPLIER','SUPPORT','MEMBER')),
  last_read_at timestamptz,
  muted boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conversation_members_user ON conversation_members(user_id);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sender_id uuid REFERENCES users(id),
  type text NOT NULL DEFAULT 'TEXT' CHECK (type IN ('TEXT','IMAGE','SYSTEM','OFFER_REF')),
  body text,
  media_id uuid,
  client_message_id text,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sender_id, client_message_id)
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE message_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id),
  reporter_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACTIONED','DISMISSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_id)
);
CREATE TABLE notification_templates (
  template_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS','PUSH','KAKAO_ALIMTALK')),
  locale text NOT NULL DEFAULT 'ko-KR',
  subject text,
  body text NOT NULL,
  PRIMARY KEY (template_key, channel, locale)
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  template_key text NOT NULL,
  category text NOT NULL DEFAULT 'TRANSACTIONAL' CHECK (category IN ('TRANSACTIONAL','SECURITY','MARKETING','SYSTEM')),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel)
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id),
  channel text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','SUPPRESSED')),
  provider_ref text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (notification_id, channel)
);

-- OPS-01 support
CREATE TABLE support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid REFERENCES users(id),
  contact_email citext,
  category text NOT NULL,
  subject text NOT NULL,
  description text NOT NULL,
  context_type text,
  context_id uuid,
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PENDING_CUSTOMER','IN_PROGRESS','RESOLVED','CLOSED')),
  assignee_id uuid REFERENCES users(id),
  sla_due_at timestamptz,
  external_ref text,  -- e.g. Chatwoot conversation id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_queue ON support_cases(status, priority, created_at);
CREATE TABLE support_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support_cases(id),
  actor_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('COMMENT','INTERNAL_NOTE','STATUS_CHANGE','ASSIGNMENT')),
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- OPS-03 CMS
CREATE TABLE cms_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type text NOT NULL CHECK (entry_type IN ('DESTINATION','STORY','FAQ','PROMOTION','BANNER','PAGE','LEGACY_CONTENT')),
  slug text NOT NULL,
  locale text NOT NULL DEFAULT 'ko-KR',
  title text NOT NULL,
  summary text,
  body_md text,
  hero_media_id uuid,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  published_at timestamptz,
  author_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_type, slug, locale)
);

-- OPS-04 analytics events (non-PII payloads)
CREATE TABLE analytics_events (
  id bigserial PRIMARY KEY,
  event_name text NOT NULL,
  user_id uuid,
  anonymous_id text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_analytics_events ON analytics_events(event_name, occurred_at);

-- AI-01/02
CREATE TABLE ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES ai_sessions(id),
  user_id uuid REFERENCES users(id),
  intent jsonb NOT NULL,
  items jsonb NOT NULL,                  -- each item cites the live availability snapshot used
  availability_snapshot_at timestamptz NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recommendation_features (
  user_id uuid NOT NULL REFERENCES users(id),
  feature_key text NOT NULL,
  value double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);
CREATE TABLE recommendation_impressions (
  id bigserial PRIMARY KEY,
  user_id uuid,
  surface text NOT NULL,
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  position integer NOT NULL,
  personalized boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- INT-01
CREATE TABLE integration_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('ICAL','SMOOBU','GENERIC_WEBHOOK')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ERROR')),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE integration_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES integration_accounts(id),
  external_type text NOT NULL,
  external_id text NOT NULL,
  internal_type text NOT NULL,
  internal_id uuid NOT NULL,
  UNIQUE (account_id, external_type, external_id)
);
CREATE TABLE integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES integration_accounts(id),
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','CONFLICT','IGNORED','ERROR')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
