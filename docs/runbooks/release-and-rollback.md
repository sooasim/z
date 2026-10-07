# Runbook — Release & rollback (G10)

## Principles
- **Staging is automatic, production is manual** (AGENTS_MASTER invariant 12). AI agents and automation may deploy
  to staging only.
- **Immutable artifacts**: production deploys take image **digests** that were deployed and smoke-tested on staging
  (tagged `verified-<sha>` in GHCR) and carry build provenance attestations.
- **Forward-only migrations** (`packages/db/migrate.mjs`, checksummed). Rollback = previous application version on
  the *current* schema, therefore every migration must be **expand/contract** compatible with the previous release:
  add nullable columns/tables first, backfill, switch code, drop later in a separate release.

## Normal release
1. Merge to `main` → `ci` (G0–G5, release report artifact) → `deploy-staging` (build, push, migrate, deploy, smoke,
   tag `verified-<sha>`, release manifest in the run summary).
2. Check the release report (`release-report` artifact / `docs/RELEASE_REPORT.md`): G0–G8 PASS or explicitly
   waived; G9 sign-offs recorded for any flag being turned on.
3. Actions → **deploy-production** → Run workflow with `release_sha`, `api_digest`, `web_digest` from the staging
   manifest.
4. `verify-artifact` job checks digest ↔ `verified-<sha>` and provenance.
5. The `deploy` job waits for **production environment reviewers** (≥ 1 required reviewer, not the author; set in
   GitHub → Settings → Environments → production; restrict to `main`).
6. After approval: snapshot → migrate → canary (1 api task) → bake `canary_bake_seconds` with smoke + `/ready` probes
   → promote → smoke. Watch Grafana during the bake: 5xx ratio, p95, payment failures.

## Automatic rollback
Any failure after the snapshot runs `infra/scripts/deploy.sh production rollback` (previous task definitions /
images from `.deploy-state-production.json`, also uploaded as the `prod-rollback-snapshot` artifact), followed by a
smoke test. Migrations already applied stay applied (expand/contract makes this safe).

## Manual rollback
```bash
# ECS (needs AWS creds via the production deploy role) — snapshot artifact from the failed/previous run
STATE_FILE=.deploy-state-production.json DEPLOY_TARGET=ecs ALLOW_PROD_DEPLOY=1 \
  infra/scripts/deploy.sh production rollback
infra/scripts/smoke.sh https://api.jetpool.kr https://jetpool.kr
```
Or re-run deploy-production with the previous release's digests (still approval-gated) — preferred, as it is
audited in GitHub.

**Data rollback** is never done by restoring a backup over production. If bad data was written, fix forward with
compensating actions (ledger compensating entries, FSM transitions) or follow db-restore-drill.md "Real restore"
under an incident.

## Feature flags vs deploys
Business-risky capabilities (paid stay, exchange, paid guide, travel commerce, charter, automatic payouts, AI) ship
**dark** behind flags that default OFF; enabling them is a G9 decision recorded with the approver, independent of
deployment.

## Checklist (paste into the release ticket)
- [ ] release report attached, gates G0–G8 reviewed
- [ ] migrations are expand/contract compatible with the running version
- [ ] staging smoke + E2E green for this `sha`
- [ ] reviewer approval in `production` environment
- [ ] canary bake clean (5xx, p95, payments)
- [ ] post-release smoke green; snapshot artifact retained
