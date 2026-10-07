# Runbook — Database restore drill (PITR) — Gate G8

**Cadence:** quarterly (whitepaper §16.1) and before every major launch. **Owner:** Platform + Finance witness.
**Targets:** reservation/payment RPO ≤ 15 min (ledger ≤ 5 min), RTO ≤ 1 h.
**Evidence:** `reports/dr-drill.json` produced by `infra/scripts/restore-verify.sh` → read by the release report (G8).

RDS PostgreSQL keeps automated backups + WAL for PITR (staging 14 days, prod 35 days — enforced in
`infra/terraform/modules/database`). The drill restores to a **new instance**; the primary is never touched.

## 1. Prepare
- Pick a restore target time `T` (e.g. 30 min ago). Record the primary's critical totals as of `T` using the same
  query as check 7 of `infra/scripts/restore-verify.sql` (run on a read replica, or note the live values and the
  writes since `T` from `audit_logs`).
- `export RESTORE_STARTED_AT=$(date +%s) RESTORE_TARGET_TIME=<T in ISO8601>`

## 2. Restore (AWS, ap-northeast-2)

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier jetpool-prod-pg \
  --target-db-instance-identifier jetpool-prod-pg-drill-$(date +%Y%m%d) \
  --restore-time "$RESTORE_TARGET_TIME" \
  --db-subnet-group-name jetpool-prod-pg \
  --vpc-security-group-ids <sg of jetpool-prod-pg> \
  --no-multi-az --no-publicly-accessible --deletion-protection false
aws rds wait db-instance-available --db-instance-identifier jetpool-prod-pg-drill-$(date +%Y%m%d)
```
(Use `--use-latest-restorable-time` for a "restore to now" drill.) Credentials: the restored instance keeps the
master user; fetch the password from the RDS-managed secret of the source (`db_master_secret_arn` output).

## 3. Verify — run from a bastion/ECS task inside the VPC

```bash
RESTORED_DATABASE_URL="postgres://jetpool_admin:<pw>@<drill-endpoint>:5432/jetpool?sslmode=require" \
  bash infra/scripts/restore-verify.sh reports/dr-drill.json
```

The script runs these checks (all must be `t`):

| check | query intent |
|---|---|
| `schema_migrations` | migration history present (compare count with `ls packages/db/migrations`) |
| `ledger_trial_balance` | `sum(debit_minor) = sum(credit_minor)` per currency (invariant 11) |
| `ledger_tx_balanced` | no individual transaction unbalanced / multi-currency / single-legged |
| `inventory_no_overlap` | no two ACTIVE `inventory_blocks` overlap for a property (invariants 5/6) |
| `db_invariants_present` | exclusion constraints + append-only/balance triggers survived the restore |
| `payments_consistent` | ≤ 1 approved payment per subject; `refunded_minor ≤ amount_minor` |
| `critical_totals` | users / reservations / approved amounts / ledger entries — compare with step 1 |
| `recovery_point` | newest outbox/ledger timestamps → actual RPO = `T − newest write` |

Core verification queries, for manual use:

```sql
-- ledger trial balance (must return diff = 0 for every currency)
SELECT currency, sum(debit_minor) AS debit, sum(credit_minor) AS credit,
       sum(debit_minor) - sum(credit_minor) AS diff
  FROM ledger_entries GROUP BY currency;

-- no-overlap invariant (must return 0)
SELECT count(*) FROM inventory_blocks a JOIN inventory_blocks b
  ON a.property_id = b.property_id AND a.id < b.id AND a.stay_range && b.stay_range
 WHERE a.state = 'ACTIVE' AND b.state = 'ACTIVE';

-- guide capacity invariant (exclusion constraint present)
SELECT conname FROM pg_constraint WHERE contype = 'x';
```

## 4. Application smoke on the restored copy (optional, recommended yearly)
Run the api image against the restored DB in an isolated ECS task with `PAYMENT_PROVIDER=MOCK`, no outbound email,
worker **disabled** (otherwise sweeps would mutate the copy and send notifications), then
`infra/scripts/smoke.sh http://<task-ip>:4000`.

## 5. Tear down & record
```bash
aws rds delete-db-instance --db-instance-identifier jetpool-prod-pg-drill-<date> --skip-final-snapshot
```
Record in the ops log: target time, actual RPO, RTO (`rtoMinutes` in the evidence file), deltas, operator,
witness. Attach `reports/dr-drill.json` to the release. A failed check is a **G8 FAIL** until fixed and re-drilled.

## Real restore (incident)
Same steps, then: freeze writes (maintenance flag + scale api to 0), point `DATABASE_URL` in
`jetpool/<env>/app` to the restored instance (or rename instances), run `migrate` (no-op expected), scale up,
reconcile payments made with Toss after `T` (payment-reconciliation.md §4 — Toss is the external source for
money that moved after the recovery point).
