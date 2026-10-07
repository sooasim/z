# Runbook — Legacy WONT/Sixshop cutover (MIG-01, Gate G7)

Source: whitepaper §15 (steps 1–9). This runbook covers the **cutover window** (step 8) and its prerequisites.
Migration tooling and tables: `migration_batches`, `migration_id_map`, `migration_audit`, `seo_redirects`
(packages/db/migrations 0001) and the MIG-01 CLI under `scripts/migration` / `packages/db/legacy`.

## Prerequisites (must be complete before scheduling — G7)
- [ ] **Official exports** obtained (Sixshop admin export / API). No scraping of passwords or payment data.
- [ ] **Dry-run reconciliation** on staging with the latest export, signed off by migration owner + business:
      row counts per entity, unique identities (email/phone normalised), order/amount totals, media checksums and
      broken-link count, consent evidence present, redirect coverage of high-value URLs.
      Evidence file: `reports/migration-dryrun.json` (`{ ok, redirectCoverage, approvedBy, ... }`) → release report G7.
- [ ] **301 map approved** (`seo_redirects`): top inbound URLs from Search Console/analytics all mapped; canonical
      tags and sitemap generated.
- [ ] **Account transition strategy approved**: legacy password hashes are not assumed compatible → users receive a
      secure password-reset / invite flow; consent records migrated with original timestamps and versions.
- [ ] DNS TTLs for `jetpool.kr`, `www`, legacy shop domains lowered to 60 s at least 48 h before.
- [ ] Communication: customer notice (maintenance window), support macros, status page.
- [ ] Rollback owner and decision deadline named.

## Cutover timeline (example: Tue 01:00–05:00 KST)

| T | Step | Owner | Verify |
|---|---|---|---|
| T-60m | Go/no-go call: G0–G8 green, dry-run approval, people present | IC | checklist above |
| T-0 | **Write freeze** on legacy: shop to maintenance/read-only, disable new orders/sign-ups/inquiries | Legacy admin | test order rejected |
| T+5m | **Final delta export** (records created/changed since the dry-run export) | Migration | export timestamps ≥ freeze |
| T+20m | Import delta: `migrate --batch final --apply` (idempotent via `migration_id_map`) | Migration | batch status COMPLETED |
| T+40m | **Reconciliation** of the full dataset (same report as dry-run) — deltas must be 0 or explained | Migration + business | `migration_audit` report |
| T+50m | **Backup**: RDS manual snapshot `jetpool-prod-pg-precutover-<date>`; archive legacy export (encrypted, private bucket) | Platform | snapshot available |
| T+60m | **DNS/CDN switch**: Route53 records → CloudFront (Terraform `edge` module), legacy hostnames → 301 to new URLs | Platform | `dig`, curl -I on 20 sample URLs |
| T+70m | **Smoke**: `infra/scripts/smoke.sh`, login (incl. password-reset email), search, listing pages, content pages, a MOCK-free test payment with a staff card then refund | QA | all green |
| T+90m | **Open**: remove maintenance; legacy stays read-only | IC | traffic flowing |
| T+90m → T+48h | **Rollback window** (below) + hyper-care monitoring | On-call | dashboards |

## Rollback (within the window)
Decision criteria: auth failure rate > 5 %, payment failures > 10 %, 404 rate on mapped URLs > 2 %, or data
reconciliation delta discovered.
1. DNS back to legacy (TTL 60 s), lift legacy write freeze.
2. New platform to maintenance; **keep its data** (no deletes) for forensic comparison.
3. Any orders/payments taken on the new platform during the window are exported and replayed manually on legacy or
   refunded (payment-reconciliation.md).
4. Postmortem before rescheduling.

## Post-cutover (step 9)
- Monitor 7 days: auth (login/reset completion), payments, 404 rate (Grafana / CloudFront logs), error rate.
- Daily `migration_audit` report until deltas are 0 for 3 consecutive days.
- After 30 days and business sign-off: decommission legacy, keep encrypted export per retention policy
  (docs/SECURITY.md §Retention).
