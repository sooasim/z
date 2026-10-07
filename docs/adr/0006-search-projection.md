# ADR-0006 — Search as a rebuildable projection (Meilisearch) with PostgreSQL fallback

- Status: Accepted · Date: 2026-10-07 · Modules: STAY-04, GUIDE-03, PLAT-01 · Invariant: 1

## Context
Discovery needs typo-tolerant text search, facets, geo and fast p95 (< 300 ms target). Inventory correctness must not
depend on the search engine being fresh or even available.

## Decision
- Meilisearch indexes are a **projection** fed by outbox events (`property.*`, `availability.changed`, guide events)
  and a periodic reconciliation job (`search.reconcile`, every 10 min) that compares PostgreSQL with the index and
  repairs drift. Sync position is tracked in `search_sync_state`.
- The index can be **dropped and rebuilt** from PostgreSQL at any time (PLAT-01 acceptance).
- Only public, publishable data is indexed (no exact addresses — approximate geo only; no private fields).
- When `MEILI_HOST` is unset or Meilisearch is unhealthy, search falls back to PostgreSQL queries (slower, still
  correct), so search outages degrade performance, not availability.
- Search results are **candidates**. Quote and hold always recheck authoritative availability and price in the
  booking transaction (STAY-04 / GUIDE-03 acceptance); a stale index can at most cause a 409 at hold time
  (monitored by `BookingCollisionSpike`).

## Consequences
- + Search can scale and be replaced independently; DR does not need to restore the index.
- − Eventual consistency (seconds) between edits and search; acceptable for discovery.
- Ops: dead letters on `search-*` consumers are low severity (outbox-dead-letters.md); a full rebuild is a safe
  remediation.
