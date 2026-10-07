# JETPOOL Release Report

- Generated: 2026-10-07T19:12:58.438Z
- Commit: `7e425ccb0f635343ba585fc245a354146fd50df9`
- Evidence directory: `../../../tmp/claude-0/reports` (6 files)
- **Release candidate: NO** (blocking: G5)

> Production deployment is never automatic. G9 (legal/business) and G10 (GitHub Environment `production`
> approval) are always human decisions (AGENTS_MASTER invariant 12).

| Gate | Name | Status | Evidence |
|---|---|---|---|
| G0 | Spec integrity | ✅ PASS | 55 modules (44 P0), 0 spec errors; implementation gaps: 27 modules without route tags, 27 owned tables without migration |
| G1 | Contracts | ⚪ NOT RUN | no contract evidence |
| G2 | Data | 🟡 PARTIAL | migrate --verify ok on 1/1 PG versions; exclusion constraints=?; deterministic seed not verified |
| G3 | Domain | ⚪ NOT RUN | no vitest-api.json |
| G4 | End-to-end | ⚪ NOT RUN | Stay paid: no tests; Exchange bilateral: no tests; Guide free/paid: no tests; Travel order: no tests |
| G5 | Security | ❌ FAIL | gitleaks 0 finding(s); PAN/CVC guard ok; SCA high=2 critical=3; SBOM missing; SAST: CodeQL workflow (see Security tab) |
| G6 | Performance | ⚪ NOT RUN | load tests run nightly / on dispatch (ci.yml `load` job) |
| G7 | Migration | ⚪ NOT RUN | no migration dry-run evidence (MIG-01, docs/runbooks/legacy-cutover.md) |
| G8 | DR & Ops | 🟡 PARTIAL | runbooks 8/8; alert rules present; restore drill: no evidence; payment reconciliation tests: not run |
| G9 | Legal/Business approval | 🔒 REQUIRES HUMAN APPROVAL | Accommodation/guide/travel/charter gates, merchant-of-record & settlement policy, published terms/privacy/refund — sign-off by legal/business owners (feature flags stay OFF until then) |
| G10 | Production approval | 🔒 REQUIRES HUMAN APPROVAL | Immutable digest verified on staging + GitHub Environment `production` reviewer approval + canary/smoke/rollback in deploy-production.yml |

## Implementation gaps (from G0)

- Modules without a tagged route: CORE-01, CORE-02, CORE-03, CORE-04, TRUST-01, TRUST-02, TRUST-03, HOST-01, STAY-05, TRAVEL-01, TRAVEL-02, TRAVEL-03, TRAVEL-04, JET-01, PAY-01, PAY-02, FIN-02, FIN-03, COMMS-01, COMMS-02, OPS-01, OPS-02, OPS-03, OPS-04, PLAT-04, PLAT-06, INT-01
- Owned tables without migration: STAY-07:fee_rules, EXCH-01:exchange_eligibility, EXCH-04:agreement_acceptances, EXCH-06:exchange_state_history, GUIDE-01:guide_languages, GUIDE-01:guide_specialties, GUIDE-02:guide_time_blocks, GUIDE-03:guide_search_projection, GUIDE-05:guide_booking_history, TRAVEL-02:travel_inventory, TRAVEL-03:itinerary_days, TRAVEL-03:itinerary_activities, JET-01:charter_content, PAY-01:payment_attempts, FIN-02:payouts, FIN-03:fee_rules, FIN-03:tax_rules, FIN-03:receipt_records, OPS-01:support_case_links, OPS-02:admin_saved_views, OPS-03:cms_external_refs, PLAT-01:search_projection_offsets, PLAT-02:geo_cache, PLAT-03:dead_letters, PLAT-05:risk_events, PLAT-05:security_incidents, PLAT-06:config_versions

## How each gate is evaluated

See `docs/OPERATIONS.md` §Release gates. Re-generate locally with `bash scripts/oneclick.sh` or `pnpm release:report`.
