-- Machine translation cache for member-written content (listing names/descriptions/house rules, review bodies
-- and replies, host and guide bios).
--
-- The source text is NOT moved or duplicated into a "translations" table keyed by entity: it stays exactly
-- where it is and remains the only authority (AGENTS_MASTER invariant 1 — AI output is a projection). This
-- table is a cache keyed by **a hash of the source string**, so:
--   * editing a listing invalidates its translation automatically (the hash changes, the row is simply never
--     looked up again) — a stale translation can never be served for edited text;
--   * identical phrasing across listings ("체크인 15:00 이후") is translated once, not once per row;
--   * nothing here has to be migrated or backfilled when an entity is deleted.
--
-- Rows are disposable. Dropping the table only costs the next reader a re-translation.
CREATE TABLE IF NOT EXISTS content_translations (
  source_hash char(64) NOT NULL,                 -- sha256 of the exact source text
  target_locale text NOT NULL CHECK (target_locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  translated text NOT NULL CHECK (length(translated) <= 20000),
  source_locale text,                            -- what the model detected, when it reports it
  provider text NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, target_locale)
);

-- Reader path is always "these N hashes in this locale"; the PK covers it. This index serves the janitor
-- ("drop translations older than X") without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_content_translations_created ON content_translations(created_at);

-- OFF by default like every other AI feature (PLAT-06): it sends member-written content to a model and costs
-- money per call, so switching it on is a deliberate operator decision. With the flag on but no
-- ANTHROPIC_API_KEY configured the read path still serves whatever is already cached and translates nothing
-- new, which is why warming the cache offline (scripts/translate-content.mjs) is a supported way to run it.
INSERT INTO feature_flags(flag_key, description, enabled) VALUES
 ('content.auto_translate','Machine-translate member-written content (listings, reviews, bios) for readers in another language', false)
ON CONFLICT (flag_key) DO NOTHING;
