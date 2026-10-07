# Spec table name → implementation mapping

`dd/JETPOOL_MASTER_BUILD_SPEC.yaml` lists `owned_or_primary_tables` for every module. Most of them exist
under the same name in `packages/db/migrations`. The names below don't. Either the schema stores the data
in a different shape (a shared log, an array column, a filtered table), or the data has no SQL table at all.

For each SQL-backed name there is a read-only compatibility **VIEW** with the spec name. Most are in
`packages/db/migrations/0900_spec_compat_views.sql`. The authoritative writes always go to the real
tables in the `implementation` column. No code writes to these views, and none of them holds state of
its own. `apps/api/test/spec-compat.test.ts` runs every view against the migrated test database.

`scripts/validate-spec.mjs` (G0) reads the fenced `yaml` block below. A spec table counts as present
when a migration creates it (table or view), or when it has an entry here that checks out:

| kind | meaning | what validate-spec checks |
|---|---|---|
| `view` | a SQL view named after the spec table | a migration runs `CREATE VIEW <specName>`, and every table in `tables` is created by a migration |
| `table` | the spec table is a real table with another name | every table in `tables` is created by a migration |
| `column` | the spec table is a column (or array column) of another table | every table in `tables` is created by a migration |
| `in-memory` | the data is a process-local cache with no authority, so nothing is persisted | the source file in `source` exists |

`implementation` is free text for people to read. `tables` lists the real tables that hold the data.
For a view, the first entry in `tables` is the primary source.

```yaml
mapping:
  # ---------------------------------------------------------------- STAY-07 / FIN-03 rule engine
  fee_rules:
    kind: view
    implementation: "finance_rules WHERE rule_type IN ('PLATFORM_FEE','HOST_FEE')"
    tables: [finance_rules]
    migration: 0900_spec_compat_views.sql
  tax_rules:
    kind: view
    implementation: "finance_rules WHERE rule_type IN ('TAX','WITHHOLDING','EVIDENCE') (EVIDENCE = tax-evidence issuance rules)"
    tables: [finance_rules]
    migration: 0900_spec_compat_views.sql
  receipt_records:
    kind: view
    implementation: "receipts (PAYMENT / REFUND / SETTLEMENT_STATEMENT / TAX_EVIDENCE)"
    tables: [receipts]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- EXCH-01..06
  exchange_eligibility:
    kind: view
    implementation: "exchange_profiles JOIN users (status, identity_verified_at) + published exchange-enabled properties + active sanctions; same predicates as evaluateEligibility()"
    tables: [exchange_profiles, users, properties, sanctions]
    migration: 0900_spec_compat_views.sql
  agreement_acceptances:
    kind: view
    implementation: "exchange_agreements accepted_a_* / accepted_b_* unpivoted to one row per party (A = requester, B = responder)"
    tables: [exchange_agreements, exchange_requests]
    migration: 0900_spec_compat_views.sql
  exchange_state_history:
    kind: view
    implementation: "state_transitions WHERE aggregate_type = 'EXCHANGE'"
    tables: [state_transitions]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- GUIDE-01..05
  guide_languages:
    kind: view
    implementation: "unnest(guide_profiles.languages) WITH ORDINALITY"
    tables: [guide_profiles]
    migration: 0900_spec_compat_views.sql
  guide_specialties:
    kind: view
    implementation: "unnest(guide_profiles.specialties) WITH ORDINALITY"
    tables: [guide_profiles]
    migration: 0900_spec_compat_views.sql
  guide_time_blocks:
    kind: view
    implementation: "guide_availability WHERE status = 'BLOCKED' UNION ALL guide_bookings ranges in ACCEPTED/PAYMENT_PENDING/CONFIRMED/IN_PROGRESS"
    tables: [guide_availability, guide_bookings]
    migration: 0900_spec_compat_views.sql
  guide_search_projection:
    kind: view
    implementation: "published guide_profiles of ACTIVE users, coarse location, published review count (shape of publicProfile())"
    tables: [guide_profiles, users, reviews]
    migration: 0900_spec_compat_views.sql
  guide_booking_history:
    kind: view
    implementation: "state_transitions WHERE aggregate_type = 'GUIDE_BOOKING'"
    tables: [state_transitions]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- TRAVEL-02 / TRAVEL-03
  travel_inventory:
    kind: view
    implementation: "travel_departures capacity / booked / remaining, min-participant status, cutoff, sellable flag"
    tables: [travel_departures]
    migration: 0900_spec_compat_views.sql
  itinerary_days:
    kind: view
    implementation: "itinerary_items grouped by (itinerary_id, day_index) plus the itineraries start_date..end_date span"
    tables: [itinerary_items, itineraries]
    migration: 0900_spec_compat_views.sql
  itinerary_activities:
    kind: view
    implementation: "itinerary_items (one row per item, with day_no / day_date)"
    tables: [itinerary_items, itineraries]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- JET-01
  charter_content:
    kind: view
    implementation: "cms_entries WHERE entry_type = 'PAGE' AND slug = 'jetpool-charter'"
    tables: [cms_entries]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- PAY-01
  payment_attempts:
    kind: view
    implementation: "state_transitions WHERE aggregate_type = 'payment' JOIN payments (provider, subject, amount, failure_code)"
    tables: [state_transitions, payments]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- FIN-02
  payouts:
    kind: view
    implementation: "settlements in PAYOUT_PENDING/PAID/RECONCILED (payout_account_id, payout_ref, paid_at) + payout_accounts bank_code/last4 + settlement FSM timestamps"
    tables: [settlements, payout_accounts, state_transitions]
    migration: 0900_spec_compat_views.sql
  # ---------------------------------------------------------------- PLAT-01 / PLAT-02
  search_projection_offsets:
    kind: view
    implementation: "search_sync_state aggregated per index_name (counts by status, watermarks, lag_seconds)"
    tables: [search_sync_state]
    migration: 0900_spec_compat_views.sql
  geo_cache:
    kind: in-memory
    implementation: "implemented as in-process cache (non-authoritative): CachedGeocoder wraps the provider in an LruCache (2000 entries, 24 h TTL); on provider failure it falls back to StaticGeocoder and does not cache the result"
    source: apps/api/src/modules/geo/geocoder.ts
  # ---------------------------------------------------------------- views defined by earlier migrations
  reservation_state_history:
    kind: view
    implementation: "state_transitions WHERE aggregate_type = 'RESERVATION'"
    tables: [state_transitions]
    migration: 0003_stay_booking.sql
  dead_letters:
    kind: view
    implementation: "outbox_events WHERE dead_lettered_at IS NOT NULL"
    tables: [outbox_events]
    migration: 0800_platform_risk.sql
```

## Notes

- **FSM history.** Every state machine writes to the shared append-only `state_transitions` log through
  `StateMachine.transition` / `recordTransition` in `apps/api/src/platform/fsm.ts`. The history views
  filter on the `aggregate_type` string that the owning module passes to `new StateMachine(...)`:
  `'EXCHANGE'`, `'GUIDE_BOOKING'`, `'payment'`, `'RESERVATION'`. If a module renames its aggregate type,
  the matching view must be replaced in a new forward migration.
- **Eligibility, sellability and search projections are derived.** `exchange_eligibility.eligible`,
  `travel_inventory.sellable` and `guide_search_projection` are computed when queried and mirror the
  service-layer checks. They are not the gate. The gates are `evaluateEligibility()`, the atomic
  `UPDATE travel_departures … WHERE booked + qty <= capacity`, and the availability recheck at guide
  booking time (invariant 1).
- **`geo_cache` is deliberately not persisted.** Geocoding results are cached per process with no
  authority, and the provider sits behind an adapter that can be replaced (PLAT-02). Address precision
  shown to users follows the privacy policy: listing coordinates are fuzzed in `fuzzCoordinates`. Nothing
  reads geo data from PostgreSQL, so a table or view would only add a second, stale copy.
- **Schema changes.** The views list their columns explicitly, so adding a column to a base table does
  not affect them. A forward migration that drops or retypes a column a view uses must recreate that view
  in the same file.
- Some spec tables are real tables now and are not listed here: `risk_events`, `security_incidents`,
  `config_versions` (0800) and `admin_saved_views`, `support_case_links`, `cms_external_refs` (0801).
