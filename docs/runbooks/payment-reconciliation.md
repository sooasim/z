# Runbook — Payment reconciliation (PAY-01 / PAY-02 / FIN-01)

**Alerts:** `PaymentsStuckConfirming`, `PaymentConfirmFailures`, `LedgerTrialBalanceNonZero`, `WebhooksUnprocessed`
**Owner:** Finance on-call (`#jetpool-finance-ops`) · escalation: platform on-call
**Invariants:** 3 (browser success URL never confirms), 4 (webhooks idempotent), 11 (ledger append-only, balanced)

## How payments settle

```
CREATED --(server POST /v1/payments/toss/confirm: amount/order/subject checked)--> CONFIRMING --(Toss confirm OK)--> APPROVED
                                                                          \--(Toss error)--> FAILED
CONFIRMING older than 120 s --> worker job `payments.reconcile-confirming` re-fetches the payment from Toss
CREATED past expires_at   --> worker job `payments.expire`
Toss webhook (/v1/webhooks/toss) --> never trusted as-is: the payment is re-fetched from Toss, then reconciled
```

A reservation whose payment is `CONFIRMING`/`APPROVED` is **never** expired by the hold sweeper (ADR-0004); the
hold is extended in 5-minute steps while the provider is in flight.

## 1. Triage (5 min)

```sql
-- stuck or failing payments by state (read replica or primary, read-only)
SELECT status, count(*), min(updated_at) AS oldest, sum(amount_minor) AS minor
  FROM payments WHERE updated_at > now() - interval '1 day' GROUP BY status ORDER BY status;

SELECT id, provider_order_id, subject_type, subject_id, amount_minor, currency, status, failure_code, updated_at
  FROM payments WHERE status = 'CONFIRMING' AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT 50;

SELECT failure_code, count(*) FROM payments
 WHERE status = 'FAILED' AND updated_at > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC;
```

- Many `CONFIRMING` + provider timeouts → check https://status.tosspayments.com and API egress (NAT, WAF).
- Spike of one `failure_code` (e.g. `REJECT_CARD_COMPANY`) → issuer side; communicate, no data fix.
- `AMOUNT_MISMATCH` / `ORDER_MISMATCH` → possible tampering; open a security incident (incident-response.md).

## 2. Is the worker running the reconcile job?

```sql
SELECT job_name, status, count(*), max(started_at) FROM job_runs
 WHERE job_name LIKE 'payments.%' AND started_at > now() - interval '30 minutes' GROUP BY 1,2;
```
No rows → worker is down: ECS service `worker` / deployment `jetpool-worker` (alarm `*-worker-no-running-tasks`).
Restart it; the job is idempotent (row lock `FOR UPDATE SKIP LOCKED`, provider status is authoritative).

## 3. Reconcile a single payment (ACCOUNTING/ADMIN, AAL2)

```
POST /v1/admin/payments/{id}/reconcile        # re-fetches from Toss and applies the provider state
GET  /v1/admin/payments/reconciliation        # list of mismatches between JETPOOL and provider state
```
Both calls are audited (`audit_logs`). Never `UPDATE payments SET status = ...` by hand — the FSM writes
`state_transitions`, emits outbox events (reservation confirmation, ledger posting) and keeps the ledger consistent.

## 4. Daily settlement file reconciliation

1. Download the Toss settlement report for D-1 (merchant console or settlements API).
2. Compare per `provider_order_id`: amount, status, approval time, refunds.
   ```sql
   SELECT provider_order_id, status, amount_minor, refunded_minor, approved_at
     FROM payments WHERE approved_at >= date_trunc('day', now() - interval '1 day')
                     AND approved_at <  date_trunc('day', now());
   ```
3. Differences:
   - In Toss, not in JETPOOL as APPROVED → reconcile endpoint (§3). If the subject cannot be confirmed any more
     (dates taken), the payment handler issues an automatic full refund — verify a `refunds` row exists.
   - In JETPOOL APPROVED, not in Toss → **P1 incident**; freeze payouts (`payout.automatic` flag OFF).
4. Record the run (date, operator, deltas) in the finance log; deltas must be 0 before settlement approval (FIN-02).

## 5. Ledger checks

```sql
-- trial balance per currency: must be zero
SELECT currency, sum(debit_minor) - sum(credit_minor) AS diff FROM ledger_entries GROUP BY currency;
-- every approved payment has a ledger posting
SELECT p.id FROM payments p
 WHERE p.status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED')
   AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.source_type = 'PAYMENT' AND t.source_id = p.id);
```
Ledger rows are append-only (trigger `jp_reject_mutation`). Corrections are **compensating transactions** with
`reverses_transaction_id`, posted through `postLedger` by finance tooling, never `UPDATE`/`DELETE`.

## 6. Exit criteria
- `jetpool_db_payments_stuck_confirming == 0`, trial balance 0, settlement deltas 0.
- Post a summary in `#jetpool-finance-ops`; incidents with customer impact get a postmortem.

**G8 evidence:** the CI suite includes reconciliation tests (`/reconcil/` in test names) — the release report
counts them. Run this runbook end-to-end on staging once per quarter with Toss test keys.
