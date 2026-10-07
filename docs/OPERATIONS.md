# JETPOOL Operations (PLAT-04)

Environments: `dev` (docker compose / local), `staging` (auto-deployed from `main`), `prod` (manual approval).
Region: AWS **ap-northeast-2 (Seoul)**; CloudFront/WAF global (us-east-1 control plane).
Infra code: `infra/terraform` (ECS Fargate default), `infra/k8s` (kustomize alternative), `infra/fly` (Fly.io alternative).

## SLOs

| SLI | Objective | Measurement | Alert |
|---|---|---|---|
| API availability | **99.9 %** monthly (43 min error budget) | `1 − 5xx / all` from `jetpool_http_request_duration_seconds_count` (ALB `HTTPCode_Target_5XX` as backup) | `ApiErrorBudgetFastBurn` (14.4× burn, 5m & 1h), `ApiHigh5xxRate`, CloudWatch `*-api-5xx-ratio` |
| Search latency | **p95 < 300 ms** (`/v1/search/*`) | histogram `route=~"/v1/search/.*"` | `SearchLatencySLO` (ticket) |
| Quote / hold latency | **p95 < 500 ms** (`/v1/booking/quotes`, `/v1/booking/holds`) | histogram per route; CloudWatch `TargetResponseTime p95` | `QuoteHoldLatencySLO` (page), `*-api-p95-latency` |
| General read API | p95 < 300 ms | histogram by route | dashboard |
| Booking write (excluding PG time) | p95 < 1 s | histogram (reservation/payment routes) | dashboard |
| Outbox lag | oldest pending < 60 s (alert at 300 s) | `jetpool_db_outbox_oldest_pending_seconds` | `OutboxOldestEventStale` |
| Payment reconciliation lag | 0 payments `CONFIRMING` > 5 min | `jetpool_db_payments_stuck_confirming` | `PaymentsStuckConfirming` |
| No oversell | 0 overlapping ACTIVE blocks (DB-enforced) | k6 hold race + `check-oversell.mjs` | G6 |

Whitepaper §16.1 sets search at < 500 ms initially; we hold ourselves to **300 ms** and confirm with load tests (G6).

**DR objectives:** reservation/payment RPO ≤ 15 min (ledger ≤ 5 min), RTO ≤ 1 h; quarterly restore drill
(`docs/runbooks/db-restore-drill.md`).

## Telemetry

| Signal | Source | Where |
|---|---|---|
| Metrics | API `/metrics` (prom-client, prefix `jetpool_`): `http_request_duration_seconds{method,route,status}`, `domain_events_total{event_type}`, `outbox_pending`, Node runtime | Prometheus (`infra/observability/prometheus/prometheus.yml`) / ADOT collector on ECS |
| Business/SoT metrics | postgres_exporter custom queries (`infra/observability/postgres-exporter/queries.yaml`): outbox pending/dead letters/age, expired holds, payments failed/stuck, webhooks, job failures, ledger trial balance | Prometheus |
| AWS metrics | ALB, RDS, ElastiCache, ECS Container Insights, WAF | CloudWatch alarms (`infra/terraform/modules/observability`) → SNS |
| Logs | pino JSON (secrets redacted), correlation id = request id = `x-correlation-id` | CloudWatch `/jetpool/<env>/{api,worker,web,migrate}` |
| Traces | OpenTelemetry → collector (`infra/observability/otel/collector.yaml`, PII scrubbing, tail sampling on errors/slow/money paths) | OTLP backend of choice |
| Synthetics | `infra/scripts/smoke.sh` after every deploy; k6 smoke against staging | GitHub Actions |

Dashboard: Grafana **"JETPOOL — Platform overview"** (`infra/observability/grafana/dashboards/jetpool-overview.json`):
HTTP/SLO, bookings & hold collisions, outbox, payments/finance (reconciliation lag, trial balance), runtime/DB.
Local stack: `docker compose -f docker-compose.yml -f infra/observability/docker-compose.observability.yml up -d`.

`/metrics` and `/docs` are blocked at the edge (WAF rule + ALB rule); scrape inside the VPC/cluster only.

> Note: the worker process has no HTTP listener, so worker-side health is observed through the DB-derived metrics
> (job_runs, outbox age, hold backlog) and ECS running-task alarms.

## On-call

| Route | Who | Channel | When |
|---|---|---|---|
| `severity=page`, prod | Primary on-call (platform rotation, weekly) → secondary after 15 min → engineering manager after 30 min | PagerDuty + `#jetpool-ops` | 24/7 |
| `team=finance` pages | Finance on-call + primary | `#jetpool-finance-ops` | 24/7 for payment failures/stuck/trial balance |
| `team=booking` pages | Booking domain owner (business hours) / primary (night) | `#jetpool-ops` | |
| `team=security` | Security lead + CPO for personal data | `#jetpool-security` | |
| `severity=ticket` | Owning team backlog | Slack | business hours (KST) |
| staging | `#jetpool-staging` | Slack only | never pages |

Routing is configured in `infra/observability/alertmanager/alertmanager.yml` (PagerDuty routing key and Slack
webhooks are mounted secrets) and CloudWatch alarms publish to SNS `jetpool-<env>-alerts` (subscribe PagerDuty/Chatbot).
**G8** requires that alert routes are tested: fire a test alert per route each quarter (`amtool alert add` /
`aws cloudwatch set-alarm-state`) and record it.

## Runbooks
| Situation | Runbook |
|---|---|
| Payments stuck/failing, settlement deltas, ledger checks | `docs/runbooks/payment-reconciliation.md` |
| Missed/failed webhooks | `docs/runbooks/webhook-replay.md` |
| Expired holds not released | `docs/runbooks/hold-expiry-backlog.md` |
| Outbox backlog / dead letters | `docs/runbooks/outbox-dead-letters.md` |
| Restore drill / real restore | `docs/runbooks/db-restore-drill.md` |
| Any incident (incl. security) | `docs/runbooks/incident-response.md` |
| Releases, canary, rollback | `docs/runbooks/release-and-rollback.md` |
| Legacy WONT/Sixshop cutover | `docs/runbooks/legacy-cutover.md` |

## Capacity
- RDS connections: `(api tasks max + worker tasks) × DATABASE_POOL_MAX` must stay < 80 % of `max_connections`
  (alert `PostgresConnectionsHigh`). Prod defaults: api max 12 × 20 + worker 2 × 20 = 280 → db.r7g.large
  (~1,700 max_connections) is ample; staging t4g.medium (~400) with api max 3.
- API autoscaling: ECS target tracking at 60 % CPU (k8s HPA equivalent). Worker scale-out is safe (SKIP LOCKED).
- Load test profiles: `scripts/load/*.js` (nightly in CI, on demand via `workflow_dispatch`).

## Release gates — how each is evaluated

| Gate | Automated evidence | Where |
|---|---|---|
| G0 Spec integrity | `scripts/validate-spec.mjs` — P0 fields, deps, CSV ↔ spec, AsyncAPI/OpenAPI seed references, gates; warnings for missing route tags/tables | `ci.yml` spec |
| G1 Contracts | `pnpm contracts:generate` → `packages/contracts/openapi.json`; Redocly lint; AsyncAPI validate (advisory); oasdiff breaking-change report on PRs | `ci.yml` contracts |
| G2 Data | `migrate.mjs --verify` on PG 16 & 17; exclusion constraints + ledger trigger present; seed run twice deterministic | `ci.yml` db |
| G3 Domain | vitest (unit/integration), transition-negative & idempotency test counts | `ci.yml` api |
| G4 End-to-end | `apps/api/test/e2e-*.test.ts` chains (stay paid, exchange bilateral, guide free/paid, travel order) | `ci.yml` api |
| G5 Security | gitleaks, PAN/CVC guard, pnpm audit, SBOM, CodeQL, permission-negative & AAL2 tests | `ci.yml` security + `codeql.yml` |
| G6 Performance | k6 search/quote/hold-race thresholds + DB no-oversell check | `ci.yml` load (nightly/dispatch) |
| G7 Migration | `reports/migration-dryrun.json` + business sign-off | MIG-01 / legacy-cutover.md |
| G8 DR & Ops | runbooks present, alert rules present, `reports/dr-drill.json`, reconciliation tests | release report |
| G9 Legal/Business | **always REQUIRES HUMAN APPROVAL** | release ticket |
| G10 Production | **always REQUIRES HUMAN APPROVAL** — digest verified on staging, GitHub `production` environment reviewers, canary + smoke + auto-rollback | `deploy-production.yml` |

Report: `docs/RELEASE_REPORT.md` (generated by `scripts/release-report.mjs`; CI artifact `release-report`).

## Incident log
Postmortems are linked here (date · sev · title · link).
