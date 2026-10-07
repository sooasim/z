# Runbook — Outbox backlog & dead letters (PLAT-03)

**Alerts:** `OutboxBacklog`, `OutboxOldestEventStale`, `OutboxDeadLetters`, `WorkerJobsFailing`
**Owner:** Platform on-call

## Design recap
- Domain events are written to `outbox_events` in the **same transaction** as the state change.
- The worker (`node dist/worker.js`) dispatches batches with `FOR UPDATE SKIP LOCKED`; each (consumer, event) pair is
  recorded in `outbox_consumptions`, so a handler runs at most once per event even across retries.
- A failing handler is retried with exponential backoff (`2^attempts` s, max 1 h). After **8 attempts** the event is
  dead-lettered (`dead_lettered_at`), `last_error` holds `<consumer>: <message>`.
- Consumers that already succeeded for that event are **not** re-run on retry.

## 1. Backlog (pending events growing)

```sql
SELECT count(*) AS pending, min(created_at) AS oldest
  FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL;
SELECT event_type, count(*), max(attempts) FROM outbox_events
 WHERE published_at IS NULL AND dead_lettered_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```
- `attempts = 0` everywhere → worker not dispatching: check the worker service, DB connectivity, `OUTBOX_POLL_MS`.
- High `attempts` on one `event_type` → a consumer is failing; see `last_error`, fix forward, events retry automatically.

## 2. Dead letters

```
GET  /v1/admin/outbox/dead-letters            # ADMIN, AAL2 — list with last_error
POST /v1/admin/outbox/dead-letters/{id}/retry # resets attempts/dead_lettered_at; audited
```
```sql
SELECT id, event_type, aggregate_type, aggregate_id, attempts, last_error, dead_lettered_at
  FROM outbox_events WHERE dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at DESC LIMIT 50;
```

Procedure:
1. Group by `last_error` consumer prefix. Identify the bug or the dependency outage (e.g. Meilisearch down for
   `search.*` consumers — search is a projection; PostgreSQL fallback keeps search working).
2. Fix and deploy (or wait for the dependency).
3. Retry via the admin endpoint (single) or, for a bulk retry after a fix, from a DB session with the ADMIN
   change ticket number recorded:
   ```sql
   -- bulk retry of one consumer's failures after a fix (records who/why in the ticket)
   UPDATE outbox_events SET dead_lettered_at = NULL, attempts = 0, available_at = now()
    WHERE dead_lettered_at IS NOT NULL AND last_error LIKE 'search-projection:%';
   ```
   This is safe because consumers are deduplicated by `outbox_consumptions`.
4. **Never delete** outbox rows; they are the event audit trail.

## 3. Payment/booking-critical consumers
If dead letters belong to payment-subject or reservation-confirmation consumers, also run
payment-reconciliation.md §5 (ledger checks) after the retry completes.

## 4. Verify
`jetpool_db_outbox_pending` back to baseline, `jetpool_db_outbox_oldest_pending_seconds < 60`,
`jetpool_db_outbox_dead_letters` not growing.
