# JETPOOL

> 유료숙박 · 홈 익스체인지 · 가이드 프렌드 · 여행 커머스를 하나의 거래 플랫폼으로 —
> 각 도메인의 상태머신은 독립적으로 유지하면서 신원·신뢰·캘린더·메시징·알림·정산 인프라를 계약으로 공유합니다.
>
> A commercial travel marketplace unifying **Paid Stay, Home Exchange, Guide Friend and Travel Commerce** with
> payments/settlement, messaging, trust and operations — without collapsing their independent domain state machines.

---

## 한국어 요약

| 항목 | 내용 |
|---|---|
| 구조 | pnpm 모노레포 · modular monolith (ADR-0001). `apps/api` Fastify 5 + PostgreSQL, `apps/web` Next.js 15, `packages/db` SQL 마이그레이션 |
| 원장(SoT) | PostgreSQL — 중복예약 방지 exclusion constraint, 복식부기 원장 트리거(ADR-0002). 검색·Redis·Realtime·AI는 projection |
| 결제 | TossPayments 서버측 승인 + 웹훅 재조회 대사(ADR-0003). 카드번호/CVC 미저장 |
| 법률 게이트 | 유료숙박·익스체인지·유료가이드·여행커머스·전세기 거래는 기능 플래그 기본 OFF, 규칙은 effective-dated 데이터(ADR-0005) |
| 배포 | 원클릭 = 명세검증 → 테스트 → Staging 자동배포 → Release Gate → **Production 수동 승인** |
| 빠른 시작 | `docker compose up --build` → http://localhost:3000 (web), http://localhost:4000/docs (API) |
| 명세 위치 | `dd/` (시작: `dd/README_START_HERE.md`, `dd/AGENTS_MASTER.md`) |

---

## Architecture

Diagrams (Graphviz sources + rendered SVG in `dd/diagrams/`):

| Diagram | File |
|---|---|
| System context | [`dd/diagrams/system_context.svg`](dd/diagrams/system_context.svg) |
| Containers | [`dd/diagrams/containers.svg`](dd/diagrams/containers.svg) |
| Domain boundaries | [`dd/diagrams/domain_boundaries.svg`](dd/diagrams/domain_boundaries.svg) |
| Booking sequence (hold → pay → confirm) | [`dd/diagrams/booking_sequence.svg`](dd/diagrams/booking_sequence.svg) |
| Exchange sequence | [`dd/diagrams/exchange_sequence.svg`](dd/diagrams/exchange_sequence.svg) |
| Deployment | [`dd/diagrams/deployment.svg`](dd/diagrams/deployment.svg) |
| AI one-click pipeline | [`dd/diagrams/ai_pipeline.svg`](dd/diagrams/ai_pipeline.svg) |

```
apps/api      Fastify API + worker (outbox dispatcher, sweeps) — modules per bounded context (apps/api/src/modules/*)
apps/web      Next.js customer / host / guide / supplier / admin UI
packages/db   forward-only, checksummed SQL migrations + runner (migrate.mjs)
infra/        Terraform (AWS Seoul), kustomize (k8s), Fly configs, Docker entrypoints, observability, deploy scripts
scripts/      validate-spec (G0), module-status (CHECKLIST), release-report, oneclick pipeline, k6 load tests (G6), PAN/CVC guard
docs/         PLAN, CONVENTIONS, CHECKLIST, ADRs, runbooks, SECURITY, OPERATIONS, RELEASE_REPORT
dd/           product/spec source of truth (master spec, OpenAPI/AsyncAPI seeds, DB blueprint, traceability, gates)
```

Key decisions: [`docs/adr/`](docs/adr) — 0001 modular monolith · 0002 PostgreSQL SoT & DB invariants ·
0003 Toss server confirm · 0004 hold TTL during payment · 0005 legal gates as config/flags · 0006 search projection.

## Quickstart

### Option A — Docker Compose (full stack)
```bash
docker compose up --build
# web http://localhost:3000 · api http://localhost:4000 (Swagger UI /docs) · mailpit http://localhost:8025
# minio console http://localhost:9001 (minio / minio12345) · meilisearch http://localhost:7700
```
`migrate` runs once (forward-only migrations) before `api` and `worker` start. Payments use the `MOCK` provider and
OAuth is mocked — local only.

Optional observability: `docker compose -f docker-compose.yml -f infra/observability/docker-compose.observability.yml up -d`
(Prometheus :9090, Grafana :3001).

### Option B — local PostgreSQL + pnpm
Requirements: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), PostgreSQL 16+ on `localhost:5432`.

Run the cluster in **UTC** (`timezone = 'UTC'`, which is the default for the Docker image and CI). The tests
build period boundaries from `new Date().toISOString()`, so on a cluster set to a local zone the settlement
and departure tests fail whenever the local date is ahead of the UTC date.
```bash
pnpm install --frozen-lockfile
cp .env.example .env                 # adjust DATABASE_URL etc.
pnpm db:migrate                      # packages/db/migrate.mjs
pnpm db:seed                         # optional dev seed
pnpm dev:api                         # http://localhost:4000
pnpm --filter @jetpool/api exec tsx watch src/worker.ts   # worker (outbox + sweeps)
pnpm dev:web                         # http://localhost:3000
docker compose up -d redis meilisearch minio minio-init mailpit   # optional backing services
```

## Environment variables (API / worker)

Defined and validated in `apps/api/src/platform/config.ts`. In `NODE_ENV=production` the API refuses to start with
default `JWT_SECRET`/`DATA_ENCRYPTION_KEY`, `PAYMENT_PROVIDER=MOCK` or `OAUTH_MOCK=true`.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` · `test` · `staging` · `production` |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | API listener |
| `DATABASE_URL` | `postgres://postgres@localhost:5432/jetpool` | PostgreSQL (source of truth) |
| `DATABASE_POOL_MAX` | `20` | pg pool size per process |
| `JWT_SECRET` | dev placeholder | access-token signing (≥ 32 chars) — **secret** |
| `JWT_ISSUER`, `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_SEC` | `jetpool`, `900`, `2592000` | tokens |
| `DATA_ENCRYPTION_KEY` | zeros | 32-byte hex key for field encryption (MFA secrets…) — **secret** |
| `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `CORS_ORIGINS` | localhost | URLs / CORS |
| `RATE_LIMIT_PER_MIN` | `600` | app-level rate limit |
| `PAYMENT_PROVIDER` | `MOCK` | `TOSS` \| `MOCK` (MOCK forbidden in prod) |
| `TOSS_SECRET_KEY`, `TOSS_CLIENT_KEY`, `TOSS_WEBHOOK_SECRET`, `TOSS_API_BASE` | – | TossPayments — **secret** |
| `PAYMENT_TTL_SEC`, `HOLD_TTL_SEC`, `QUOTE_TTL_SEC` | `900`, `900`, `1800` | payment / hold / quote lifetimes (ADR-0004) |
| `GOOGLE_*`, `KAKAO_*`, `NAVER_*` (`CLIENT_ID`/`CLIENT_SECRET`) | – | OAuth providers — **secret** |
| `OAUTH_MOCK` | `false` | mock OAuth (dev/test only) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PRIVATE`, `S3_BUCKET_PUBLIC`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `ap-northeast-2`, `jetpool-private`, `jetpool-public` | media storage (on AWS use the task role, no keys) |
| `CDN_BASE_URL` | `http://localhost:4000/media-dev` | public media base URL |
| `MEILI_HOST`, `MEILI_API_KEY` | unset → PostgreSQL search fallback | search projection (ADR-0006) |
| `NOVU_API_KEY`, `SMTP_URL` | – | notifications |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | –, `claude-sonnet-5-5` | AI assistant (flag `ai.assistant`, default OFF) |
| `GEOCODER`, `KAKAO_REST_API_KEY` | `STATIC` | geo adapter |
| `OUTBOX_POLL_MS` | `1000` | worker outbox polling |
| `LOG_LEVEL` | `info` | pino log level |

Web: `NEXT_PUBLIC_API_URL` (inlined at build time — build one image per environment).

## Tests

```bash
cd apps/api && npx vitest run                    # unit + integration + E2E chains (real PostgreSQL, DB per file)
cd apps/api && npx vitest run test/<file>        # single file
pnpm --filter @jetpool/api typecheck
pnpm --filter @jetpool/web typecheck && pnpm --filter @jetpool/web build
node packages/db/migrate.mjs --verify            # G2: clean apply + idempotent re-run on a scratch DB
node scripts/validate-spec.mjs                   # G0
node scripts/module-status.mjs                   # per-module DoD vs the spec (pnpm checklist writes docs/CHECKLIST.md)
node scripts/check-no-pan.mjs                    # G5: no card data columns
BASE_URL=http://localhost:4000 bash scripts/load/run-all.sh reports   # G6 (needs k6, non-prod only)
```

## One-click pipeline

```bash
bash scripts/oneclick.sh          # install → validate-spec → migrate verify → typecheck → tests → contracts → web build → security → report
VITEST_WORKERS=4 bash scripts/oneclick.sh   # cap test parallelism (each test file gets its own database)
RUN_LOAD=1 bash scripts/oneclick.sh   # + k6 load / no-oversell
```
It mirrors CI and writes `docs/RELEASE_REPORT.md` (+ evidence in `reports/`). **It never deploys.**

Delivery (`.github/workflows/`):
1. `ci.yml` — G0–G5 on every PR/push (+ G6 nightly), release report artifact.
2. `codeql.yml` — SAST.
3. `deploy-staging.yml` — after CI on `main`: build & push images (GHCR, provenance + SBOM) → migrate → deploy
   (`infra/scripts/deploy.sh staging`, target `DEPLOY_TARGET=ecs|k8s|fly`) → smoke → tag digests `verified-<sha>`.
4. `deploy-production.yml` — manual `workflow_dispatch` with verified digests → **GitHub Environment `production`
   approval** → snapshot → migrate → canary → bake/smoke → promote → automatic rollback on failure.

## Release gates (G0–G10)

| Gate | Name | Checked by |
|---|---|---|
| G0 | Spec integrity | `scripts/validate-spec.mjs` |
| G1 | Contracts | OpenAPI export + Redocly lint, AsyncAPI validate, breaking-change diff |
| G2 | Data | `migrate.mjs --verify` on PG 16/17, invariant presence, deterministic seed |
| G3 | Domain | vitest unit/integration, transition-negative, idempotency |
| G4 | End-to-end | `apps/api/test/e2e-*.test.ts` (stay paid, exchange bilateral, guide free/paid, travel order) |
| G5 | Security | gitleaks, CodeQL, pnpm audit, SBOM, PAN/CVC guard, permission-negative & AAL2 tests |
| G6 | Performance | k6 search/quote/hold-race + DB no-oversell check |
| G7 | Migration | MIG-01 dry-run reconciliation + approvals (`docs/runbooks/legacy-cutover.md`) |
| G8 | DR & Ops | restore drill evidence, runbooks, alert routes, payment reconciliation tests |
| G9 | Legal/Business approval | **human** sign-off (feature flags stay OFF until then) |
| G10 | Production approval | **human** — GitHub Environment reviewers, immutable digest, canary + rollback |

Details: [`docs/OPERATIONS.md`](docs/OPERATIONS.md#release-gates--how-each-is-evaluated) ·
security model: [`docs/SECURITY.md`](docs/SECURITY.md) · runbooks: [`docs/runbooks/`](docs/runbooks).

## Where specs live

| What | Path |
|---|---|
| Start here / agent contract & 12 invariants | `dd/README_START_HERE.md`, `dd/AGENTS_MASTER.md` |
| Master build spec (55 modules, gates) | `dd/JETPOOL_MASTER_BUILD_SPEC.yaml` |
| One-click build spec | `dd/JETPOOL_AI_ONECLICK_BUILD_SPEC.md` |
| API / event seeds | `dd/JETPOOL_OPENAPI_SKELETON.yaml`, `dd/JETPOOL_ASYNCAPI_SKELETON.yaml` (generated contract: `packages/contracts/openapi.json`) |
| DB blueprint | `dd/JETPOOL_DB_SCHEMA_BLUEPRINT.sql` (implemented in `packages/db/migrations`) |
| Traceability / UI routes | `dd/JETPOOL_MODULE_TRACEABILITY.csv`, `dd/JETPOOL_UI_ROUTE_MAP.csv` |
| Release gates | `dd/JETPOOL_RELEASE_GATES.yaml` |
| Whitepapers | `dd/JETPOOL_2차_상용화_모듈_아키텍처_기술백서.*`, `dd/source_docs/` |
| Plan / conventions / checklist | `docs/PLAN.md`, `docs/CONVENTIONS.md`, `docs/CHECKLIST.md` |
