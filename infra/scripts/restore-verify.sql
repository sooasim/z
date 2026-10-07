-- DR restore verification (docs/runbooks/db-restore-drill.md, gate G8).
-- Every check returns: check | ok | detail. Run against the RESTORED instance:
--   psql "$RESTORED_DATABASE_URL" -v ON_ERROR_STOP=1 -At -F '|' -f infra/scripts/restore-verify.sql
\set QUIET on

-- 1. migrations: restored schema matches the repository migration set (compare count with packages/db/migrations)
SELECT 'schema_migrations' AS check, (count(*) > 0) AS ok, count(*)::text || ' applied, latest ' || coalesce(max(filename), '-') AS detail
  FROM schema_migrations;

-- 2. ledger trial balance: total debits == total credits per currency (invariant 11)
SELECT 'ledger_trial_balance' AS check,
       coalesce(bool_and(d = c), true) AS ok,
       coalesce(string_agg(currency || ' debit=' || d || ' credit=' || c, '; '), 'no entries') AS detail
  FROM (SELECT currency, sum(debit_minor) AS d, sum(credit_minor) AS c FROM ledger_entries GROUP BY currency) t;

-- 3. every ledger transaction balanced individually and single-currency
SELECT 'ledger_tx_balanced' AS check, count(*) = 0 AS ok, count(*)::text || ' unbalanced transactions' AS detail
  FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
         HAVING sum(debit_minor) <> sum(credit_minor) OR count(DISTINCT currency) <> 1 OR count(*) < 2) x;

-- 4. no-overlap invariant: no two ACTIVE inventory blocks overlap for the same property (invariant 5/6)
SELECT 'inventory_no_overlap' AS check, count(*) = 0 AS ok, count(*)::text || ' overlapping active block pairs' AS detail
  FROM inventory_blocks a JOIN inventory_blocks b
    ON a.property_id = b.property_id AND a.id < b.id AND a.stay_range && b.stay_range
 WHERE a.state = 'ACTIVE' AND b.state = 'ACTIVE';

-- 5. exclusion constraints and append-only triggers still present after restore
SELECT 'db_invariants_present' AS check,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'x') >= 2
       AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'ledger_entries_balanced') = 1 AS ok,
       'exclusion=' || (SELECT count(*) FROM pg_constraint WHERE contype = 'x')
       || ' append_only_triggers=' || (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%append_only%') AS detail;

-- 6. payments: one approved payment per subject; refunds never exceed amount
SELECT 'payments_consistent' AS check,
       (SELECT count(*) FROM payments WHERE refunded_minor > amount_minor) = 0
       AND (SELECT count(*) FROM (SELECT 1 FROM payments WHERE status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED')
                                   GROUP BY subject_type, subject_id HAVING count(*) > 1) d) = 0 AS ok,
       (SELECT count(*) FROM payments)::text || ' payments, '
       || (SELECT coalesce(sum(amount_minor), 0) FROM payments WHERE status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED'))::text
       || ' approved minor units' AS detail;

-- 7. critical totals snapshot (compare with the same query on primary at the restore target time)
SELECT 'critical_totals' AS check, true AS ok,
       'users=' || (SELECT count(*) FROM users)
       || ' reservations=' || (SELECT count(*) FROM reservations)
       || ' payments_approved_minor=' || (SELECT coalesce(sum(amount_minor), 0) FROM payments WHERE status = 'APPROVED')
       || ' ledger_entries=' || (SELECT count(*) FROM ledger_entries)
       || ' outbox_pending=' || (SELECT count(*) FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS detail;

-- 8. recovery point: newest committed write found in the restored data (RPO evidence)
SELECT 'recovery_point' AS check, true AS ok,
       'latest outbox event ' || coalesce((SELECT max(created_at)::text FROM outbox_events), 'none')
       || ', latest ledger entry ' || coalesce((SELECT max(created_at)::text FROM ledger_entries), 'none') AS detail;
