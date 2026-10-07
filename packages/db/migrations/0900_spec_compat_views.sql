-- 0900 QA · spec traceability: read-only compatibility VIEWS for table names that
-- dd/JETPOOL_MASTER_BUILD_SPEC.yaml (owned_or_primary_tables) uses but that the schema implements under a
-- different name / shape. Every view is a faithful projection of the authoritative tables; none of them is
-- written to by application code (PostgreSQL remains the single source of truth, invariant 1).
-- The full spec-name → implementation mapping (including non-SQL implementations such as geo_cache) lives in
-- docs/SPEC_TABLE_MAPPING.md and is read by scripts/validate-spec.mjs.
--
-- Columns are listed explicitly (no SELECT *), so later forward migrations that ADD columns to the base tables
-- do not change these views. A forward migration that drops/retypes a column used here must
-- CREATE OR REPLACE / DROP the dependent view in the same file.

-- ================================================================================================ STAY-07 / FIN-03
-- fee_rules / tax_rules → finance_rules partitioned by rule_type (effective-dated, maker-checker approved).
CREATE VIEW fee_rules AS
  SELECT id, rule_type, domain, jurisdiction, params, effective_from, effective_until, status,
         approved_by, approved_at, created_by, note, created_at
    FROM finance_rules
   WHERE rule_type IN ('PLATFORM_FEE', 'HOST_FEE');

-- TAX (VAT on fees), WITHHOLDING and EVIDENCE (tax-evidence issuance rules) are the tax side of FIN-03.
CREATE VIEW tax_rules AS
  SELECT id, rule_type, domain, jurisdiction, params, effective_from, effective_until, status,
         approved_by, approved_at, created_by, note, created_at
    FROM finance_rules
   WHERE rule_type IN ('TAX', 'WITHHOLDING', 'EVIDENCE');

-- ================================================================================================ FIN-03
CREATE VIEW receipt_records AS
  SELECT id, user_id, payment_id, receipt_type, amount_minor, currency, data, issued_at
    FROM receipts;

-- ================================================================================================ EXCH-01
-- Live eligibility per exchange member. Mirrors evaluateEligibility() in apps/api/src/modules/exchange/service.ts
-- (same predicates, same order of `unmet`). exchange_profiles.status is the snapshot written on profile upsert;
-- `eligible` here is recomputed at query time. The service function stays the authoritative gate.
CREATE VIEW exchange_eligibility AS
  SELECT ep.user_id,
         ep.status AS profile_status,
         u.status AS account_status,
         u.identity_verified_at,
         (u.identity_verified_at IS NOT NULL) AS identity_verified,
         h.exchange_home_count,
         s.active_sanction,
         c.profile_complete,
         array_remove(ARRAY[
           CASE WHEN u.status <> 'ACTIVE' THEN 'ACCOUNT_NOT_ACTIVE' END,
           CASE WHEN u.identity_verified_at IS NULL THEN 'IDENTITY_NOT_VERIFIED' END,
           CASE WHEN h.exchange_home_count = 0 THEN 'NO_EXCHANGE_HOME' END,
           CASE WHEN s.active_sanction THEN 'ACTIVE_SANCTION' END,
           CASE WHEN NOT c.profile_complete THEN 'PROFILE_INCOMPLETE' END
         ]::text[], NULL) AS unmet,
         (u.status = 'ACTIVE' AND u.identity_verified_at IS NOT NULL AND h.exchange_home_count > 0
           AND NOT s.active_sanction AND c.profile_complete) AS eligible,
         ep.updated_at
    FROM exchange_profiles ep
    JOIN users u ON u.id = ep.user_id
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS exchange_home_count
        FROM properties p
       WHERE p.host_id = ep.user_id AND p.exchange_enabled AND p.status = 'PUBLISHED'
    ) h
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM sanctions x
         WHERE x.user_id = ep.user_id AND x.lifted_at IS NULL AND x.sanction_type <> 'WARNING'
           AND x.starts_at <= now() AND (x.ends_at IS NULL OR x.ends_at > now())
      ) AS active_sanction
    ) s
    CROSS JOIN LATERAL (
      SELECT (char_length(regexp_replace(coalesce(ep.home_description, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g')) >= 10
              AND cardinality(ep.preferred_destinations) >= 1) AS profile_complete
    ) c;

-- ================================================================================================ EXCH-04
-- One row per party acceptance (party A = requester, B = responder), unpivoted from exchange_agreements.
-- Acceptance evidence is never overwritten (the service only sets accepted_*_at when it is NULL).
CREATE VIEW agreement_acceptances AS
  SELECT ea.id AS agreement_id, ea.exchange_id, 'A'::text AS party, 'REQUESTER'::text AS party_role,
         er.requester_id AS user_id, ea.terms_version, ea.terms_hash, ea.offer_version,
         ea.accepted_a_at AS accepted_at, ea.accepted_a_evidence AS evidence, ea.status AS agreement_status
    FROM exchange_agreements ea
    JOIN exchange_requests er ON er.id = ea.exchange_id
   WHERE ea.accepted_a_at IS NOT NULL
  UNION ALL
  SELECT ea.id, ea.exchange_id, 'B'::text, 'RESPONDER'::text,
         er.responder_id, ea.terms_version, ea.terms_hash, ea.offer_version,
         ea.accepted_b_at, ea.accepted_b_evidence, ea.status
    FROM exchange_agreements ea
    JOIN exchange_requests er ON er.id = ea.exchange_id
   WHERE ea.accepted_b_at IS NOT NULL;

-- ================================================================================================ EXCH-06 / GUIDE-05 / PAY-01
-- FSM history views over the shared append-only state_transitions log (same pattern as reservation_state_history
-- in 0003). aggregate_type strings are those passed to `new StateMachine(...)` / recordTransition by each module.
CREATE VIEW exchange_state_history AS
  SELECT id, aggregate_id AS exchange_id, from_state, to_state, actor_id, actor_type, reason, correlation_id,
         metadata, created_at
    FROM state_transitions
   WHERE aggregate_type = 'EXCHANGE';

CREATE VIEW guide_booking_history AS
  SELECT id, aggregate_id AS guide_booking_id, from_state, to_state, actor_id, actor_type, reason, correlation_id,
         metadata, created_at
    FROM state_transitions
   WHERE aggregate_type = 'GUIDE_BOOKING';

-- Every payment state step (CREATED at prepare, CONFIRMING, APPROVED / FAILED, refunds/cancel) with the payment's
-- provider and subject. Provider-side retries of the same step are recorded in webhook_events.
CREATE VIEW payment_attempts AS
  SELECT st.id, st.aggregate_id AS payment_id, p.provider, p.provider_order_id, p.payer_id, p.subject_type,
         p.subject_id, p.amount_minor, p.currency, st.from_state, st.to_state,
         CASE WHEN st.to_state = 'FAILED' THEN p.failure_code END AS failure_code,
         st.actor_id, st.actor_type, st.reason, st.correlation_id, st.metadata, st.created_at
    FROM state_transitions st
    JOIN payments p ON p.id = st.aggregate_id
   WHERE st.aggregate_type = 'payment';

-- ================================================================================================ GUIDE-01
CREATE VIEW guide_languages AS
  SELECT g.user_id AS guide_id, l.language, l.ordinality::int AS sort_order
    FROM guide_profiles g
    CROSS JOIN LATERAL unnest(g.languages) WITH ORDINALITY AS l(language, ordinality);

CREATE VIEW guide_specialties AS
  SELECT g.user_id AS guide_id, sp.specialty, sp.ordinality::int AS sort_order
    FROM guide_profiles g
    CROSS JOIN LATERAL unnest(g.specialties) WITH ORDINALITY AS sp(specialty, ordinality);

-- ================================================================================================ GUIDE-02
-- Time the guide cannot be booked: explicit BLOCKED availability windows (blackouts) plus the ranges held by
-- active bookings (the statuses covered by the no_overlapping_guide_bookings exclusion constraint).
CREATE VIEW guide_time_blocks AS
  SELECT a.id, a.guide_id, a.start_at, a.end_at, 'BLACKOUT'::text AS block_type,
         'guide_availability'::text AS source_table, NULL::text AS booking_status
    FROM guide_availability a
   WHERE a.status = 'BLOCKED'
  UNION ALL
  SELECT b.id, b.guide_id, b.start_at, b.end_at, 'BOOKING'::text,
         'guide_bookings'::text, b.status
    FROM guide_bookings b
   WHERE b.status IN ('ACCEPTED', 'PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS');

-- ================================================================================================ GUIDE-03
-- Public search projection: published guides of ACTIVE users, coarse (~1 km) location, price only when paid —
-- the same shape the search service returns via publicProfile(). Availability is rechecked at booking time.
CREATE VIEW guide_search_projection AS
  SELECT g.user_id AS guide_id, u.display_name, g.guide_type, g.headline, g.bio, g.city, g.regions, g.languages,
         g.interests, g.specialties,
         round(g.lat, 2) AS approx_lat, round(g.lng, 2) AS approx_lng,
         g.paid_enabled,
         CASE WHEN g.paid_enabled THEN g.hourly_price_minor END AS hourly_price_minor,
         g.currency, g.max_group_size,
         (g.verification_status = 'VERIFIED') AS verified,
         g.rating_avg,
         (SELECT count(*)::int FROM reviews r
           WHERE r.target_type = 'GUIDE' AND r.target_id = g.user_id AND r.status = 'PUBLISHED') AS review_count,
         g.updated_at
    FROM guide_profiles g
    JOIN users u ON u.id = g.user_id
   WHERE g.status = 'PUBLISHED' AND u.status = 'ACTIVE';

-- ================================================================================================ TRAVEL-02
-- Departure capacity ledger. `sellable` mirrors the atomic checkout reservation predicate in travel/service.ts
-- (status OPEN|GUARANTEED, seats left, not yet started); the UPDATE … WHERE booked + qty <= capacity stays authoritative.
CREATE VIEW travel_inventory AS
  SELECT d.id AS departure_id, d.product_id, d.starts_at, d.ends_at, d.capacity, d.booked,
         greatest(d.capacity - d.booked, 0) AS remaining,
         d.min_participants, (d.booked >= d.min_participants) AS min_participants_met,
         d.cutoff_at, coalesce(d.cutoff_at, d.starts_at - interval '48 hours') AS effective_cutoff_at,
         d.price_minor, d.status, (d.status = 'GUARANTEED') AS guaranteed,
         (d.status IN ('OPEN', 'GUARANTEED') AND d.booked < d.capacity AND d.starts_at > now()) AS sellable
    FROM travel_departures d;

-- ================================================================================================ TRAVEL-03
-- itinerary_items carries day_index (0-based, max 365); days are the itinerary's date span plus any day that has items.
CREATE VIEW itinerary_days AS
  WITH days AS (
    SELECT i.id AS itinerary_id, gs.day_index
      FROM itineraries i
      CROSS JOIN LATERAL generate_series(0, least(greatest(i.end_date - i.start_date, 0), 365)) AS gs(day_index)
     WHERE i.start_date IS NOT NULL AND i.end_date IS NOT NULL
    UNION
    SELECT itinerary_id, day_index FROM itinerary_items
  )
  SELECT d.itinerary_id, d.day_index, d.day_index + 1 AS day_no, (i.start_date + d.day_index) AS day_date,
         count(it.id)::int AS activity_count, min(it.start_time) AS first_start_time, max(it.end_time) AS last_end_time
    FROM days d
    JOIN itineraries i ON i.id = d.itinerary_id
    LEFT JOIN itinerary_items it ON it.itinerary_id = d.itinerary_id AND it.day_index = d.day_index
   GROUP BY d.itinerary_id, d.day_index, i.start_date;

CREATE VIEW itinerary_activities AS
  SELECT it.id, it.itinerary_id, it.day_index, it.day_index + 1 AS day_no, (i.start_date + it.day_index) AS day_date,
         it.sort_order, it.item_type AS activity_type, it.ref_id, it.title, it.start_time, it.end_time, it.note
    FROM itinerary_items it
    JOIN itineraries i ON i.id = it.itinerary_id;

-- ================================================================================================ JET-01
-- Charter brand/IA content is the CMS PAGE 'jetpool-charter' (all locales and statuses; the public API serves
-- PUBLISHED only and falls back to built-in default content).
CREATE VIEW charter_content AS
  SELECT id, slug, locale, title, summary, body_md, hero_media_id, seo, data, status, published_at, author_id,
         created_at, updated_at
    FROM cms_entries
   WHERE entry_type = 'PAGE' AND slug = 'jetpool-charter';

-- ================================================================================================ FIN-02
-- A payout is the execution leg of a settlement (1:1): settlements from PAYOUT_PENDING onward, with the payout
-- account (bank code + last4 only; the provider token is never exposed) and the FSM timestamps.
CREATE VIEW payouts AS
  SELECT s.id, s.id AS settlement_id, s.payee_id, s.payee_type, s.payout_account_id, pa.bank_code, pa.account_last4,
         s.net_minor AS amount_minor, s.currency,
         CASE s.status WHEN 'PAYOUT_PENDING' THEN 'PENDING' WHEN 'PAID' THEN 'SENT' WHEN 'RECONCILED' THEN 'RECONCILED' END AS status,
         s.status AS settlement_status, s.payout_ref,
         (SELECT max(t.created_at) FROM state_transitions t
           WHERE t.aggregate_type = 'settlement' AND t.aggregate_id = s.id AND t.to_state = 'PAYOUT_PENDING') AS requested_at,
         s.paid_at,
         (SELECT max(t.created_at) FROM state_transitions t
           WHERE t.aggregate_type = 'settlement' AND t.aggregate_id = s.id AND t.to_state = 'RECONCILED') AS reconciled_at
    FROM settlements s
    LEFT JOIN payout_accounts pa ON pa.id = s.payout_account_id
   WHERE s.status IN ('PAYOUT_PENDING', 'PAID', 'RECONCILED');

-- ================================================================================================ PLAT-01
-- Per-index projection offsets / lag derived from the per-document search_sync_state watermarks.
CREATE VIEW search_projection_offsets AS
  SELECT index_name,
         count(*)::int AS document_count,
         (count(*) FILTER (WHERE status = 'SYNCED'))::int AS synced_count,
         (count(*) FILTER (WHERE status = 'PENDING'))::int AS pending_count,
         (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed_count,
         (count(*) FILTER (WHERE status = 'DELETED'))::int AS deleted_count,
         max(source_version) AS last_source_version,
         max(source_version) FILTER (WHERE status IN ('SYNCED', 'DELETED')) AS last_synced_source_version,
         max(synced_at) AS last_synced_at,
         min(source_version) FILTER (WHERE status IN ('PENDING', 'FAILED')) AS oldest_unsynced_version,
         coalesce(greatest(extract(epoch FROM now() - min(source_version) FILTER (WHERE status IN ('PENDING', 'FAILED'))), 0), 0)::bigint AS lag_seconds
    FROM search_sync_state
   GROUP BY index_name;
