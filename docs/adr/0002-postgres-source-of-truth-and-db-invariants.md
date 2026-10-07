# ADR-0002 — PostgreSQL as source of truth; invariants enforced in the database

- Status: Accepted · Date: 2026-10-07 · Invariants: 1, 5, 6, 11 (`dd/AGENTS_MASTER.md`)

## Context
Bookings, exchanges, guide bookings and money must stay correct under concurrency, retries and partial failures.
Application-level checks alone ("SELECT then INSERT") race. Search (Meilisearch), Redis, realtime and AI are useful
but cannot be authoritative.

## Decision
PostgreSQL 16+ (RDS, PITR) is the single source of truth. Critical invariants are **database constraints**, so no
code path (including future services, scripts or manual SQL) can violate them:

| Invariant | Mechanism |
|---|---|
| No double-booking of a property (stay/exchange/host/external blocks) | `inventory_blocks` `EXCLUDE USING gist (property_id WITH =, stay_range WITH &&) WHERE state='ACTIVE'` (btree_gist) |
| Guide capacity / overlapping bookings | exclusion constraint on `guide_bookings` |
| Ledger balanced per transaction & single currency | deferred constraint trigger `jp_ledger_check_balanced` |
| Ledger append-only | `BEFORE UPDATE OR DELETE` triggers → `jp_reject_mutation()` |
| Quote immutable after creation | `booking_quotes_immutable` trigger |
| One approved payment per subject | partial unique index `uq_payments_subject_approved` |
| Webhook/idempotency replay safety | `UNIQUE(provider, external_event_id)`, `idempotency_keys(scope, key)` |
| Refund ≤ payment | `CHECK (refunded_minor <= amount_minor)` |
| Money is integer minor units | `*_minor bigint` + `currency char(3)` everywhere |

Migrations are forward-only and checksummed (`packages/db/migrate.mjs`); a modified applied migration aborts.
CI (G2) applies all migrations twice on a scratch DB (`--verify`) on PG 16 and 17 and asserts the exclusion and
ledger triggers exist. Constraint violations are mapped to stable API errors (exclusion → 409 `INVENTORY_UNAVAILABLE`).

## Consequences
- + Concurrency tests (G6 `scripts/load/hold-concurrency.js`) can only see one winner per date range.
- + DR verification can re-check invariants on a restored copy (`infra/scripts/restore-verify.sql`).
- − Schema changes need expand/contract discipline (rollback runs old code on new schema).
- − Heavier reliance on PostgreSQL features (gist, deferred triggers) — managed PG on RDS supports them.
