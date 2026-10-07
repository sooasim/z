# Runbook — Incident response (operational & security)

**Applies to:** any page (`severity=page`), customer-impacting degradation, suspected breach or data exposure.
**Roles:** Incident Commander (IC) · Ops/Tech lead · Comms lead · Scribe. One person may hold several in small incidents.

## Severity
| Sev | Definition | Examples | Response |
|---|---|---|---|
| SEV1 | Money/data integrity at risk, full outage, confirmed breach | double charges, ledger imbalance, PII leak, API down | page all, IC within 5 min, status page |
| SEV2 | Major feature degraded, SLO burn fast | payments failing > 10 %, holds not expiring, search down | page primary, IC within 15 min |
| SEV3 | Minor/partial, workaround exists | dead letters on non-critical consumer | ticket, business hours |

## First 15 minutes
1. **Acknowledge** the page; open `#inc-YYYYMMDD-<slug>`; IC posts the incident template (impact, start time, roles).
2. **Stabilise before diagnosing**:
   - bad deploy suspected → `deploy-production.yml` rollback is automatic on failed smoke; otherwise run
     `infra/scripts/deploy.sh production rollback` with the last snapshot (release-and-rollback.md).
   - risky feature → turn its **feature flag OFF** (`/v1/admin/feature-flags`, AAL2): `stay.paid_booking`,
     `exchange.enabled`, `guide.paid`, `travel.commerce`, `payout.automatic`, … Kill switches act without deploy.
   - abusive traffic → tighten WAF rate rules (Terraform var `waf_rate_limit_per_5min`) or add an IP set block.
3. **Assess money impact**: run payment-reconciliation.md §1 and §5. If the ledger is affected → SEV1.
4. Communicate every 30 min (internal) / per status-page policy (external).

## Security incidents (additional)
- **Preserve evidence**: do not delete rows, logs or containers. Snapshot the RDS instance
  (`aws rds create-db-snapshot`), export relevant CloudWatch log groups, keep WAF logs. Audit logs are append-only.
- **Contain**: rotate exposed secrets in Secrets Manager (`jetpool/<env>/app`) and redeploy (tasks read secrets at
  start); revoke sessions (`UPDATE sessions SET revoked_at = now() WHERE ...` via an audited admin action);
  revoke elevated access grants; disable compromised accounts (`users.status = 'SUSPENDED'` through the admin API).
- **Personal data breach** (개인정보 유출): the privacy officer decides on notification to data subjects and to
  PIPC/KISA. Korean PIPA requires notification without delay (in principle within 72 hours of becoming aware);
  legal confirms the exact obligations. Record what data, how many subjects, time window.
- **Payment data**: JETPOOL never stores PAN/CVC (invariant 9). Suspected card-data exposure through the
  Toss widget/redirect → notify Toss immediately.
- Contact tree: IC → CTO → privacy officer (CPO) → legal → CEO. Keep the current phone list in the on-call tool,
  not in git.

## Diagnosis toolbox
- Dashboards: Grafana "JETPOOL — Platform overview"; CloudWatch alarms `jetpool-<env>-*`.
- Logs: `/jetpool/<env>/{api,worker,web,migrate}` — search by `x-correlation-id` (returned in every response and
  stored in `state_transitions`, `audit_logs`, `outbox_events.correlation_id`).
- DB: `pg_stat_activity`, `pg_locks`; Performance Insights.

## Close & learn
- Resolve when metrics are back within SLO for 30 min and money reconciliation shows no deltas.
- Postmortem (blameless) within 5 business days for SEV1/SEV2: timeline, root cause, what went well/badly,
  action items with owners. Link it from the incident channel and `docs/OPERATIONS.md` incident log.
