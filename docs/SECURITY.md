# JETPOOL Security & Privacy (PLAT-05)

Scope: apps/api, apps/web, worker, data stores and the AWS/GitHub delivery chain. Binding rules: `dd/AGENTS_MASTER.md`
(12 invariants) and `docs/CONVENTIONS.md` §Security & privacy. Release gate: **G5** (SAST/SCA/secret scan,
permission-negative tests, AAL2, no PAN/CVC) — the release blocks on critical vulnerabilities, leaked secrets,
failed permission-negative tests or missing SBOM.

Reporting a vulnerability: security@jetpool.kr (PGP key in the on-call vault). Please do not open public issues.

---

## 1. Architecture & trust boundaries

```
Internet ──► CloudFront + WAF (managed rules, rate limits, /metrics & /docs blocked) ──► ALB (CloudFront prefix list
          + x-origin-verify header) ──► ECS tasks (private subnets): api · web · worker · migrate
                                         │            │         │
                                         ▼            ▼         ▼
                                  RDS PostgreSQL   ElastiCache  S3 private (KMS) / S3 public (OAC → CloudFront)
                                  (data subnets, TLS, KMS)      Secrets Manager (KMS)
External: TossPayments (confirm/re-fetch, webhooks) · OAuth (Google/Kakao/Naver) · Meilisearch · SMTP/Novu · Anthropic
```
Trust boundaries: (B1) browser ↔ edge, (B2) edge ↔ ALB, (B3) app ↔ data stores, (B4) app ↔ third parties
(PG, OAuth, AI), (B5) staff/admin ↔ backoffice, (B6) CI/CD ↔ cloud accounts.

## 2. Threat model (STRIDE per domain)

### 2.1 Authentication & sessions (CORE-01)
| STRIDE | Threat | Controls |
|---|---|---|
| S | Credential stuffing, OTP brute force, OAuth account-linking hijack | WAF `rate-limit-auth` (100 req/5 min/IP on `/v1/auth/*`), app rate limit, scrypt password hashing, account linking requires verified e-mail ownership + re-auth; OAuth `state`/PKCE |
| T | JWT tampering | HS256 with ≥ 32-byte `JWT_SECRET` from Secrets Manager; issuer check; short access TTL (15 min) |
| R | "I didn't log in" | `sessions` rows (created, revoked), audit of security events |
| I | Token leakage via logs | pino redaction of `authorization`, `cookie`, tokens, passwords (`REDACT_PATHS`) |
| D | Login endpoint flooding | WAF + rate limit; `/health` `/ready` excluded from limits |
| E | Session reuse after revocation / role removal | roles and session revocation re-read from DB on every request (`resolveActor`) |

### 2.2 Payments & webhooks (PAY-01/02, FIN-01)
| STRIDE | Threat | Controls |
|---|---|---|
| S | Forged success redirect / forged webhook | server-side confirm with amount/order/subject/payer checks; webhooks re-fetched from Toss, never trusted (ADR-0003, invariants 3–4) |
| T | Amount manipulation in browser | amount computed server-side from the subject; mismatch → `AMOUNT_MISMATCH` + security alert |
| R | Disputed charge | append-only double-entry ledger, `state_transitions` with actor/correlation id, `audit_logs` (category MONEY) |
| I | Card data exposure | Toss hosted widget; **no PAN/CVC storage** (invariant 9, `scripts/check-no-pan.mjs` in CI), redaction of `cardNumber`/`cvc` |
| D | Webhook floods | dedupe `UNIQUE(provider, external_event_id)`, cheap insert-then-process, WAF |
| E | Refund abuse | refund ≤ refundable balance (DB CHECK + service), ACCOUNTING/ADMIN + AAL2 for manual refunds, Idempotency-Key |

### 2.3 Inventory & bookings (STAY-06..10, EXCH-05, GUIDE-02/05)
| STRIDE | Threat | Controls |
|---|---|---|
| T | Double booking via race | exclusion constraints; availability rechecked in the hold transaction (ADR-0002) |
| D | Inventory locking by bots (mass holds) | hold TTL 15 min, per-user idempotency scope, WAF Bot Control, rate limits; alert `HoldExpiryBacklog` |
| E | Host modifies another host's calendar | ownership checks in services; permission-negative tests per route (G5) |
| I | Exact address scraping | exact address only after confirmed reservation/exchange; search index has approximate geo only |

### 2.4 Messaging privacy (COMMS-01, TRUST-03, OPS-01)
| STRIDE | Threat | Controls |
|---|---|---|
| I | Admin/support reading private P2P messages | **no global admin read** (invariant 10): `elevated_access_grants` (case-scoped, reason, ≤ 24 h); every read audited |
| S | Subscribing to another conversation's realtime channel | membership check on subscribe; negative tests |
| R | Evidence tampering in disputes | evidence hashes immutable (`dispute_evidence`), append-only events |
| T | Phishing/off-platform payment links | message reports, risk flags (PLAT-05 `risk_events`) |

### 2.5 Admin & elevation (OPS-02, CORE-03)
| STRIDE | Threat | Controls |
|---|---|---|
| E | Staff action without MFA | `requireRole` for staff roles enforces **AAL2** (TOTP) automatically |
| R | Untraceable money/permission/compliance changes | every such mutation writes `audit_logs` (append-only, secrets excluded) |
| E | Over-broad roles | scoped roles (ADMIN/ACCOUNTING/SUPPORT/EDITOR/COMPLIANCE), server-side checks on every route regardless of UI |
| S | Stolen staff session | short TTL, revocation, admin session timeout, high-risk actions → dual approval (planned) |

### 2.6 Media upload (STAY-02, TRUST-01 documents)
| STRIDE | Threat | Controls |
|---|---|---|
| T | Malicious files (polyglots, SVG XSS, malware) | presigned PUT to **private** bucket only, MIME/size allow-list, server-side processing, promotion to public bucket only after successful processing; malware scanning hook (planned: GuardDuty Malware Protection for S3) |
| I | ID documents exposed | ID/verification docs never leave the private bucket (SSE-KMS); access via short-lived presigned GET to authorised staff with audit |
| E | Overwriting other users' objects | object keys generated server-side with owner prefix; ownership verified on `complete` |
| D | Storage abuse | size limits, lifecycle expiry of unpromoted uploads (7 days) |

### 2.7 Delivery chain (B6)
| Threat | Controls |
|---|---|
| Malicious dependency / CVE | lockfile + `--frozen-lockfile`, `pnpm audit --audit-level=high`, Dependabot (npm, actions, docker, terraform), SBOM (SPDX) per CI run |
| Secret committed | gitleaks on full history (`.gitleaks.toml`), GitHub secret scanning |
| Code vulnerability | CodeQL `security-extended` (javascript-typescript) on PR/push/weekly |
| Unapproved production deploy | `production` GitHub Environment with required reviewers; AWS role trust restricted to `repo:<org/repo>:environment:production`; `deploy.sh` refuses prod outside that environment |
| Tampered image | immutable digests, `verified-<sha>` tag after staging smoke, build provenance attestation verified before prod |

## 3. Controls ↔ invariants

| # | Invariant | Primary control | Verified by |
|---|---|---|---|
| 1 | PostgreSQL is SoT | search/realtime/AI as projections; PG fallback | ADR-0006, search tests |
| 2 | Independent FSMs | separate `StateMachine`s, no cross-module table writes | code review, tests |
| 3 | Success URL never confirms | server confirm + subject handler | payment tests, smoke (unauth confirm rejected) |
| 4 | Webhooks validated/idempotent | dedupe table + provider re-fetch | webhook replay tests |
| 5 | Recheck inventory in tx + durable hold | exclusion constraint, hold before payment | concurrency tests, k6 hold race (G6) |
| 6 | Exchange blocks both homes atomically | single tx, two blocks, rollback on failure | exchange E2E (G4) |
| 7 | Paid publication gated by compliance | `evaluatePropertyCompliance`, flags OFF | compliance tests |
| 8 | No hard-coded tax/legal rule | effective-dated rule tables | ADR-0005, G9 |
| 9 | No PAN/CVC | hosted PG UI, redaction, schema guard | `check-no-pan.mjs` (G5) |
| 10 | No global admin message read | elevated access grants + audit | negative tests |
| 11 | Ledger append-only & balanced | DB triggers | DB tests, `LedgerTrialBalanceNonZero`, restore drill |
| 12 | Prod deploy needs approval | GitHub Environment + OIDC trust | deploy-production.yml, G10 |

## 4. Data classification

| Class | Examples | Storage & handling |
|---|---|---|
| **C4 Restricted** | ID document images, business registration docs, bank account numbers, MFA secrets, OAuth/PG secrets | private S3 (SSE-KMS) or encrypted columns (`DATA_ENCRYPTION_KEY`, AES-GCM); never in logs/audit; access audited; bank numbers masked (last 4) in UI/API |
| **C3 Confidential (PII)** | name, e-mail, phone, exact address, date of birth, private messages, reservation guests | RDS (KMS at rest, TLS in transit); exact address revealed only post-confirmation; minimise in events/payloads; masked for support unless elevated |
| **C2 Internal** | pricing rules, analytics aggregates, audit metadata, operational logs | private; logs retained 90 days (staging 30) — prod app logs 365 days |
| **C1 Public** | published listings, approximate geo, reviews, CMS pages, processed media | public bucket via CloudFront OAC, search index |

Card PAN/CVC: **never** collected or stored by JETPOOL (out of scope — held by TossPayments).

## 5. PII retention (defaults — confirm with legal/G9 before launch)

| Data | Retention | Basis / note |
|---|---|---|
| Contract/payment records, receipts, ledger | 5 years | 전자상거래법 (계약·대금결제 기록) |
| Consumer complaints/disputes | 3 years | 전자상거래법 |
| Advertising/marketing consent & display records | 6 months after withdrawal | 전자상거래법 / 정보통신망법 |
| Access/login logs | ≥ 3 months (we keep 1 year) | 통신비밀보호법 (접속기록) |
| Identity/verification documents | until verification decision + 90 days, then purge originals (keep decision + hash) | data minimisation |
| Private messages | life of account + 1 year, or dispute hold | dispute evidence |
| Deleted accounts | personal data erased/anonymised within 30 days of the request, except records under statutory retention (moved to restricted storage) | PIPA; `privacy.deletion` / `privacy.retention` jobs (CORE-04) |
| Legacy migration exports | 90 days after cutover sign-off, encrypted, private bucket | MIG-01 |

Retention jobs (`privacy.retention`) and export/delete workflows (`/v1/privacy/*`) are reproducible and audited.

## 6. Secrets management
- **Runtime:** AWS Secrets Manager secret `jetpool/<env>/app` (KMS CMK, 30-day recovery). ECS injects keys as env via
  the execution role; Kubernetes uses External Secrets Operator into Secret `jetpool-app`. Values are set by
  operators — Terraform only creates the container with `SET_ME` placeholders and ignores later changes.
- **Database:** RDS-managed master password (`manage_master_user_password`, rotated by RDS). The application uses a
  separate least-privilege role in `DATABASE_URL`; migrations run with the migration role.
- **CI/CD:** no long-lived cloud keys — GitHub OIDC → `jetpool-<env>-github-deploy` role, trust limited to the
  matching GitHub Environment. GHCR via `GITHUB_TOKEN`. Repository secrets only for `FLY_API_TOKEN`/`KUBECONFIG_*`
  when those targets are used.
- **Rotation:** JWT secret (dual-key rotation window = access TTL), `DATA_ENCRYPTION_KEY` (re-encrypt job required —
  plan before rotating), Toss keys (coordinate with Toss console), OAuth secrets yearly or on staff departure.
- **Local dev:** `.env` (git-ignored), `.env.example` placeholders only; production refuses dev defaults
  (`loadConfig` throws on default JWT secret/encryption key, MOCK payment, OAUTH_MOCK).
- **Leak response:** rotate first, then investigate (incident-response.md §Security).

## 7. Security testing in the pipeline (G5)
| Check | Where | Blocking |
|---|---|---|
| Secret scan (gitleaks, full history) | `ci.yml` security job | yes |
| PAN/CVC schema guard | `scripts/check-no-pan.mjs` | yes |
| SAST (CodeQL security-extended) | `codeql.yml` | findings triaged in Security tab; criticals block release |
| SCA (`pnpm audit --audit-level=high`) | `ci.yml` (continue-on-error*) | release report marks G5 FAIL on high/critical → blocks G10 |
| SBOM (SPDX) | `ci.yml` + image SBOM/provenance in `deploy-staging.yml` | missing SBOM → G5 PARTIAL |
| Permission-negative + AAL2 tests | vitest suites (`forbidden`, `AAL2` in test names) | yes (G3/G5) |
| Container image scan | ECR scan-on-push | criticals reviewed before prod |
| DAST | OWASP ZAP baseline against staging (planned, pre-launch) | — |

\* `pnpm audit` is `continue-on-error` so an advisory with no upstream fix does not freeze every PR; the release
report turns it into a FAIL for the release decision, and Dependabot PRs remediate.

## 8. Incident response
See `docs/runbooks/incident-response.md` (severity matrix, evidence preservation, containment, PIPA breach
notification within 72 h via the privacy officer, contact tree, blameless postmortem).
