# JETPOOL MASTER AGENTS.md — Production Build Contract v2

## Mission
Build JETPOOL as a production transaction platform that unifies Paid Stay, Home Exchange, Guide Friend, Travel Commerce, payment/settlement, messaging, trust and operations without collapsing their independent domain state machines.

## Non-negotiable invariants
1. PostgreSQL is the transaction Source of Truth. Meilisearch, Redis, Realtime and AI outputs are projections/caches/delivery aids only.
2. Paid Stay, Home Exchange and Guide Friend have separate FSMs. Share identity, trust, calendar, chat, notifications and finance infrastructure only through contracts.
3. A browser success URL never confirms payment or reservation. Confirm only after server-side provider confirmation and amount/order validation.
4. Every external webhook/callback is signature/secret validated where supported, replay-safe and idempotent.
5. Inventory write paths recheck availability inside a DB transaction and acquire a durable block/hold before payment.
6. Exchange confirmation atomically blocks both homes; partial success rolls back.
7. Paid accommodation and paid/pro guide publication is denied until configured compliance predicates pass.
8. Do not hard-code one universal tax/legal rule. Use effective-dated configuration and require business/legal approval.
9. Do not store raw card PAN/CVC. Use PG-hosted/tokenized flows.
10. Private P2P messages are not globally readable by admins. Access requires case-scoped, time-limited, audited elevation.
11. Ledger entries are append-only and double-entry balanced. Corrections use compensating entries.
12. Production deployment requires explicit protected-environment approval; AI may deploy automatically only to staging.

## Required implementation order
Business requirement → ADR/domain spec → OpenAPI/AsyncAPI → DB migration/JSON schema → generated types/clients → implementation → generated tests → human review → staging deploy → release gates → production approval.

## Definition of Done for each module
- API contract and authorization policy are explicit.
- Database ownership/constraints/indexes are explicit.
- Domain events are versioned and idempotent.
- UI route has loading/empty/error/permission states.
- Unit, integration, negative-permission and E2E tests exist as applicable.
- Logs/metrics/traces avoid secrets and PII leakage.
- Runbook/rollback behavior exists for operationally critical modules.

## Stop conditions
Stop the build and request a decision when a required legal/business gate is unresolved: merchant of record, accommodation eligibility, Home Exchange legal classification, paid-guide eligibility, charter transaction scope, payout/tax rule, insurance/guarantee requirement, or legacy export availability.
