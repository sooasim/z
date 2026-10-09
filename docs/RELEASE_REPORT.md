# JETPOOL Release Report

- Generated: 2026-10-09T04:41:44.772Z
- Commit: `14c1a86bd105e2033897b2224600d078199a3bce`
- Evidence directory: `reports` (11 files)
- **Release candidate: NO**

> Production deployment is never automatic. G9 (legal/business) and G10 (GitHub Environment `production`
> approval) are always human decisions (AGENTS_MASTER invariant 12).

| Gate | Name | Status | Evidence |
|---|---|---|---|
| G0 | Spec integrity | ✅ PASS | 55 modules (44 P0), 0 spec errors; implementation gaps: 0 modules without route tags, 0 owned tables without migration |
| G1 | Contracts | ✅ PASS | 329 paths / 380 operations / 53 module tags; 0 seed paths not implemented verbatim; redocly lint exit 0 |
| G2 | Data | ✅ PASS | migrate --verify ok on 1/1 PG versions; exclusion constraints=?; deterministic seed verified |
| G3 | Domain | ✅ PASS | 580/580 tests passed in 58 files; transition-negative 100/100; idempotency 38/38 |
| G4 | End-to-end | ✅ PASS | Stay paid: 13/13; Exchange bilateral: 15/15; Guide free/paid: 15/15; Travel order: 13/13 |
| G5 | Security | 🟡 PARTIAL | gitleaks not run; PAN/CVC guard ok; SCA high=0 critical=0; SBOM missing; SAST: CodeQL workflow (see Security tab); permission-negative 25/25; AAL2 23/23 |
| G6 | Performance | ⚪ NOT RUN | load tests run nightly / on dispatch (ci.yml `load` job) |
| G7 | Migration | ⚪ NOT RUN | no migration dry-run evidence (MIG-01, docs/runbooks/legacy-cutover.md) |
| G8 | DR & Ops | 🟡 PARTIAL | runbooks 8/8; alert rules present; restore drill: no evidence; payment reconciliation tests 8/8 |
| G9 | Legal/Business approval | 🔒 REQUIRES HUMAN APPROVAL | Accommodation/guide/travel/charter gates, merchant-of-record & settlement policy, published terms/privacy/refund — sign-off by legal/business owners (feature flags stay OFF until then) |
| G10 | Production approval | 🔒 REQUIRES HUMAN APPROVAL | Immutable digest verified on staging + GitHub Environment `production` reviewer approval + canary/smoke/rollback in deploy-production.yml |

## How each gate is evaluated

See `docs/OPERATIONS.md` §Release gates. Re-generate locally with `bash scripts/oneclick.sh` or `pnpm release:report`.
