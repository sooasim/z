# JETPOOL v2 상용화 구현 계획 (Commercial Build Plan)

입력 문서: `dd/` (2차 기술백서 docx, AGENTS_MASTER, MASTER_BUILD_SPEC, OpenAPI/AsyncAPI seed, DB blueprint,
Traceability CSV, UI route map, Release Gates, diagrams) + `dd/source_docs/v1_technical_whitepaper` (1차 백서).

## 1. 문서 분해 결과 (Spec decomposition)
| 구분 | 수량 | 출처 |
|---|---|---|
| 모듈 | 55 (P0 44 · P1 10 · P2 1) | MASTER_BUILD_SPEC.yaml / TRACEABILITY.csv |
| API path | 82 | OPENAPI_SKELETON.yaml |
| 도메인 이벤트 | ~120 | ASYNCAPI_SKELETON.yaml |
| UI route | 27 | UI_ROUTE_MAP.csv |
| Release Gate | G0–G10 | RELEASE_GATES.yaml |
| 불변식 | 12 | AGENTS_MASTER.md |
| 독립 FSM | Reservation · Exchange · GuideBooking · Payment · Refund · Settlement · Order | 백서 §7 |

## 2. 아키텍처 결정 (ADR-0001 요약)
- 8개 논리 repo(jetpool-web/api/booking/exchange/guide/admin/contracts/infra)를 **하나의 pnpm monorepo** 안의
  bounded-context 모듈로 구현한다(modular monolith). 모듈 간 상태 변경은 export된 서비스 계약·payment-subject 계약·
  transactional outbox 이벤트로만 수행 → 이후 서비스 분리 시 계약 그대로 유지.
- PostgreSQL 16+ = Source of Truth. Exclusion constraint(재고 중복 점유), 이중부기 balanced/append-only trigger,
  idempotency/webhook unique key를 DB 레벨에서 강제.
- 검색(Meilisearch)·Realtime·AI 출력은 projection. 미설정 시 Postgres fallback.
- 결제는 TossPayments adapter(서버측 confirm + 금액/주문/subject 대조) + 테스트용 MOCK(운영 금지).
- 법률·세무·인허가 결정은 코드 상수가 아니라 effective-dated 규칙 테이블 + 기능 플래그(기본 OFF) + G9 승인.
- 프로덕션 배포는 GitHub Environment 수동 승인. AI 자동 배포는 staging까지만.

## 3. 오픈소스 재사용 (GitHub/npm)
Fastify 5 · zod 4 · fastify-type-provider-zod · @fastify/swagger(OpenAPI 생성) · node-postgres · jose(JWT) ·
otpauth(TOTP MFA) · prom-client · pino · Meilisearch JS · AWS SDK v3(S3 presign) · @anthropic-ai/sdk ·
Next.js 15 / React 19 · MapLibre GL · Vitest · Playwright · Docker · Terraform · GitHub Actions.
(Medusa/Payload/Novu/Chatwoot은 adapter 경계로 연동 가능하도록 interface만 고정 — 백서 권고대로 핵심 IP
 Exchange/Guide/Compliance/Ledger는 자체 구현.)

## 4. 실행 단계 (One-click pipeline)
`validate-spec → migrate(template DB) → typecheck → unit/integration/E2E tests → OpenAPI export → web build →
docker build → terraform plan → deploy-staging → smoke → release-report → (manual) production approval`

## 5. 에이전트 역할 (Supervisor + 9 domain agents)
| 에이전트 | 담당 모듈 | 소유 디렉터리 |
|---|---|---|
| **Supervisor / Data / Platform-core** (메인 세션) | 아키텍처, schema 0001–0007, platform/*, 통합·검수·Release report | `apps/api/src/platform`, `packages/db`, `docs` |
| A · Identity & Trust | CORE-01..04, TRUST-01..03, HOST-01, OPS-01 | identity, profile, roles, privacy, verification, reviews, disputes, hosts, support |
| B · Stay Catalog | STAY-01..05, PLAT-01, PLAT-02 | properties, media, compliance, search, favorites, geo |
| C · Booking | STAY-06..10 | booking |
| D · Exchange | EXCH-01..06 | exchange |
| E · Guide | GUIDE-01..05 | guide |
| F · Commerce & Finance | TRAVEL-01..04, JET-01, PAY-01/02, FIN-01..03 | travel, charter, payments, finance |
| G · Comms, Ops & AI | COMMS-01/02, OPS-02..04, PLAT-06, AI-01/02, INT-01, MIG-01 | messaging, notifications, admin, cms, analytics, ai, integrations, scripts/migration |
| H · Web UX | 27 UI routes (public/traveler/host/guide/supplier/admin) | apps/web |
| I · Infra & QA | PLAT-04/05, CI/CD, IaC, runbooks, E2E chains, release gates | infra, .github, scripts, apps/api/test/e2e-* |

규칙: 각 에이전트는 자기 디렉터리만 수정, 타 도메인 상태 직접 변경 금지, 공유 계약 변경은 Supervisor 승인.
Supervisor는 각 라운드마다 typecheck + 전체 테스트 + 불변식 리뷰를 수행하고 실패 모듈을 해당 에이전트에 재할당한다.

## 6. 완료 판정 (Definition of Done)
- 모든 P0 모듈: API + 권한 + DB 제약 + 이벤트 + UI route + 테스트(positive/negative/idempotency/concurrency) 존재.
- 3대 E2E 사슬(유료숙박 / Home Exchange / Guide Friend)이 감사로그·원장까지 대사.
- G0–G8 자동 판정 리포트 생성(`pnpm release:report`), G9(법무/사업 승인)·G10(프로덕션 승인)은 사람 승인 항목으로 명시.
