# Runbook — Hold expiry backlog (STAY-08 / ADR-0004)

**Alerts:** `HoldExpiryBacklog`, `BookingCollisionSpike`, `QuoteHoldLatencySLO`
**Owner:** Booking on-call · escalation: platform on-call

Holds (`reservation_holds` + `inventory_blocks` of type `HOLD`) last `HOLD_TTL_SEC` (15 min). The worker job
`booking.hold-expiry` (every 30 s) releases expired holds — **except** when the linked reservation has a payment
in `CONFIRMING`/`APPROVED`; then the hold is extended by 5 minutes so the dates can't be sold to someone else
mid-payment. An ACTIVE hold past expiry blocks real guests from booking those dates.

## 1. Size the backlog

```sql
SELECT count(*) AS expired_active, min(expires_at) AS oldest
  FROM reservation_holds WHERE status = 'ACTIVE' AND expires_at < now();

-- holds kept alive by an in-flight payment (expected, should be few and short-lived)
SELECT h.id, h.expires_at, p.status, p.updated_at
  FROM reservation_holds h JOIN reservations r ON r.hold_id = h.id
  JOIN payments p ON p.subject_type = 'RESERVATION' AND p.subject_id = r.id
 WHERE h.status = 'ACTIVE' AND p.status IN ('CONFIRMING','APPROVED');
```

## 2. Causes and fixes

| Symptom | Cause | Action |
|---|---|---|
| no `booking.hold-expiry` rows in `job_runs` / worker not running | worker down or crash-looping | restart worker; check logs `/jetpool/<env>/worker` for `job failed` |
| job runs but backlog grows | lock contention / slow DB | check `pg_stat_activity` for long transactions on `inventory_blocks`; kill the blocker if it is an ad-hoc session |
| many holds extended by in-flight payments | Toss latency / stuck `CONFIRMING` | follow payment-reconciliation.md — once payments resolve, holds convert or expire |
| `inventory_blocks` ACTIVE but hold row already EXPIRED | partial manual intervention | see §3 |

Each sweep processes up to 200 holds per run; a large backlog drains at ~400/min. Scaling the worker to 2 tasks is
safe (`FOR UPDATE SKIP LOCKED`).

## 3. Manual release (last resort, two-person rule)

Only for holds with **no** payment in `CONFIRMING`/`APPROVED`. Use the service path, not raw SQL, so state
transitions, outbox events (`reservation.hold_expired`, `availability.changed`) and the search projection stay
consistent:

```bash
# from a worker task / pod (ECS exec or kubectl exec), runs the sweeper once
node -e "import('./dist/platform/jobs.js').then(async j => { /* registered jobs need the app */ })"
```
Preferred: scale/restart the worker and let `booking.hold-expiry` run. If the job itself is broken, ship a
forward-fix; do not `UPDATE inventory_blocks SET state='RELEASED'` by hand (it skips events and audit).

## 4. Verify
- `jetpool_db_holds_expired_unreleased == 0` for 10 min.
- Collision rate (409 on `/v1/booking/holds`) back to baseline.
- No-overlap invariant still holds (always true by exclusion constraint):
  ```sql
  SELECT count(*) FROM inventory_blocks a JOIN inventory_blocks b
    ON a.property_id = b.property_id AND a.id < b.id AND a.stay_range && b.stay_range
   WHERE a.state = 'ACTIVE' AND b.state = 'ACTIVE';   -- must be 0
  ```
