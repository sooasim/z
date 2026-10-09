# JETPOOL v2 구현 체크리스트 (Module × Definition of Done)

상태 범례: `[x]` 구현+테스트 통과 · `[~]` 부분 구현 · `[ ]` 미착수.

이 파일의 모듈 표 · Open items · Release Gates 상태 · 불변식 체크박스는 손으로 적지 않고
**`node scripts/module-status.mjs --write`** 가 명세(`dd/`)와 실제 구현을 대조해 생성한다
(판정 기준은 그 스크립트 상단 주석 참조). Release Gates 상태는 `docs/RELEASE_REPORT.md`
(`pnpm release:report` 또는 `bash scripts/oneclick.sh`)에서 가져온다. Agent 열은 `docs/PLAN.md` §5의
계획값이므로 스크립트가 보존한다.

| Module | Name | P | Agent | API | DB | Events | AuthZ | Tests | UI | Acceptance |
|---|---|---|---|---|---|---|---|---|---|---|
| CORE-01 | Identity & Authentication | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | OAuth login, logout, account-linking and AAL2-gated admin actions pass positive/negative tests. |
| CORE-02 | Profile, Locale & Preferences | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Profile updates are audited, validated and reflected across customer/host/guide views. |
| CORE-03 | Roles, Entitlements & Policy | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Server-side authorization denies every unauthorized API regardless of UI visibility. |
| CORE-04 | Consent & Privacy Lifecycle | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Consent evidence is versioned; deletion/export workflows are reproducible and auditable. |
| TRUST-01 | Identity / Business Verification | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Restricted actions remain blocked until required verification predicates are true. |
| TRUST-02 | Reviews & Reputation | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Only eligible completed transactions can create one review per review target/policy window. |
| TRUST-03 | Safety, Reports & Disputes | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Cases retain immutable evidence hashes and sensitive message access requires audited elevation. |
| HOST-01 | Host Onboarding | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Host cannot publish paid inventory until role, verification and compliance predicates are satisfied. |
| STAY-01 | Property / Listing Management | P0 | B | [x] | [x] | [x] | [x] | [x] | [x] | Draft-to-publish flow validates required content and compliance gate before public visibility. |
| STAY-02 | Media Pipeline | P0 | B | [x] | [x] | [x] | [x] | [x] | [x] | MIME/size/ownership validation and private-to-public promotion occur only after successful processing. |
| STAY-03 | Accommodation Compliance Gate | P0 | B | [x] | [x] | [x] | [x] | [x] | [x] | Paid booking cannot be enabled when required permit/eligibility checks are missing, expired or rejected. |
| STAY-04 | Stay Search & Discovery | P0 | B | [x] | [x] | [x] | [x] | [x] | [x] | Search produces candidates but checkout revalidates authoritative availability in booking DB. |
| STAY-05 | Favorites & Collections | P1 | B | [x] | [x] | [x] | [x] | [x] | [x] | Idempotent add/remove and privacy controls work across web/mobile PWA sessions. |
| STAY-06 | Availability & Calendar | P0 | C | [x] | [x] | [x] | [x] | [x] | [x] | Calendar reads and writes preserve no-overlap invariant across paid stay/exchange/host blocks. |
| STAY-07 | Pricing & Quote | P0 | C | [x] | [x] | [~] | [x] | [x] | [x] | Quote is deterministic, currency-safe, itemized, time-bounded and immutable after booking confirmation. |
| STAY-08 | Inventory Hold | P0 | C | [x] | [x] | [x] | [x] | [x] | [x] | Concurrent hold tests prove capacity cannot be exceeded for overlapping dates. |
| STAY-09 | Reservation FSM | P0 | C | [x] | [x] | [x] | [x] | [x] | [x] | Only enumerated transitions are accepted; all transitions store actor, reason and correlation id. |
| STAY-10 | Cancellation / No-show / Check-in | P0 | C | [x] | [x] | [x] | [x] | [x] | [x] | Policy calculation is tested at boundary dates and never mutates historical quote breakdown. |
| EXCH-01 | Exchange Eligibility | P0 | D | [x] | [x] | [x] | [x] | [x] | [x] | No exchange request can enter agreement stage unless both sides satisfy configured legal/safety policy. |
| EXCH-02 | Exchange Request & Counter | P0 | D | [x] | [x] | [x] | [x] | [x] | [x] | Both parties see one canonical offer version; stale-version acceptance is rejected. |
| EXCH-03 | Exchange Verification Gate | P0 | D | [x] | [x] | [x] | [x] | [x] | [x] | Agreement generation is impossible until required identity/property checks are approved. |
| EXCH-04 | Exchange Agreement & E-consent | P0 | D | [x] | [x] | [x] | [x] | [x] | [x] | Both parties accept exactly the same terms_version; acceptance evidence cannot be overwritten. |
| EXCH-05 | Exchange Calendar Lock | P0 | D | [x] | [x] | [x] | [x] | [x] | [x] | Confirmed exchange blocks both homes without colliding with paid reservations or host blocks. |
| EXCH-06 | Exchange Completion & Review | P0 | D | [x] | [x] | [x] | [x] | [x] | [x] | Completion unlocks reviews; dispute preserves evidence and blocks premature settlement/deposit release. |
| GUIDE-01 | Guide Profile & Type | P0 | E | [x] | [x] | [x] | [x] | [x] | [x] | Paid/professional offerings are blocked until required business/qualification gates are satisfied. |
| GUIDE-02 | Guide Availability | P0 | E | [x] | [x] | [x] | [x] | [x] | [x] | Overlapping confirmed guide bookings cannot exceed capacity and timezone conversions are deterministic. |
| GUIDE-03 | Guide Search & Matching | P0 | E | [x] | [x] | [x] | [x] | [x] | [x] | Result candidates are filtered by eligibility and authoritative availability is rechecked before booking. |
| GUIDE-04 | Guide Request & Offer | P0 | E | [x] | [x] | [x] | [x] | [x] | [x] | Offer acceptance uses version checks; free and paid paths are explicit and never conflated. |
| GUIDE-05 | Guide Booking FSM | P0 | E | [x] | [x] | [x] | [x] | [x] | [x] | Paid booking confirms only after server-verified payment; free booking confirms with no payment object. |
| TRAVEL-01 | Travel Catalog & Supplier | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Published product identifies seller/merchant role and has valid supplier/compliance status. |
| TRAVEL-02 | Departure / Inventory | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Checkout cannot oversell departure capacity and minimum-participant status is explicit. |
| TRAVEL-03 | Itinerary Builder | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Versioned itinerary edits preserve booked-customer snapshot when required. |
| TRAVEL-04 | Commerce Order / Cart | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Server recalculates totals; client amount is never authoritative. |
| JET-01 | Legacy Charter / Flight Share Scope Gate | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Existing brand/content is migrated; direct booking/payment flag remains OFF until an explicit release ADR and compliance approval. |
| PAY-01 | Payment Orchestrator | P0 | F | [x] | [x] | [x] | [x] | [x] | [x] | Success redirect alone never confirms a transaction; server confirmation and idempotent webhook reconciliation do. |
| PAY-02 | Refund Orchestrator | P0 | F | [x] | [x] | [x] | [x] | [x] | [x] | Refund amount cannot exceed refundable balance; duplicate provider callbacks are harmless. |
| FIN-01 | Double-entry Ledger | P0 | F | [x] | [x] | [x] | [x] | [x] | [x] | Every posted transaction balances debit/credit per currency; corrections are compensating entries, not edits. |
| FIN-02 | Settlement & Payout | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Settlement net derives from ledger; payout account changes require AAL2 and audit. |
| FIN-03 | Fee / Tax / Evidence Rule Engine | P1 | F | [x] | [x] | [x] | [x] | [x] | [x] | Rules are effective-dated/versioned and changes do not retroactively mutate historical transactions. |
| COMMS-01 | P2P Messaging | P0 | G | [x] | [x] | [x] | [x] | [x] | [x] | RLS/API policy prevents non-members from reading/subscribing; admin access requires case-based audited elevation. |
| COMMS-02 | Notification Orchestration | P0 | G | [x] | [x] | [~] | [x] | [x] | [x] | Critical booking/payment notices ignore marketing opt-out but honor mandatory-channel policy and delivery audit. |
| OPS-01 | Customer Support / Case Desk | P0 | A | [x] | [x] | [x] | [x] | [x] | [x] | Support agent access is scoped and sensitive data is masked unless elevation is granted. |
| OPS-02 | Admin / Backoffice | P0 | G | [x] | [x] | [x] | [x] | [x] | [x] | Every money/permission/compliance mutation is AAL2-gated and append-only audited. |
| OPS-03 | CMS, Content & SEO | P0 | G | [x] | [x] | [x] | [x] | [x] | [x] | Legacy high-value URLs have 301 mappings and content publication is separated from transaction truth. |
| OPS-04 | Analytics & Audit | P0 | G | [x] | [x] | [ ] | [x] | [x] | [x] | Operational metrics reconcile against source tables; audit logs exclude secrets while retaining actor/resource/effect. |
| PLAT-01 | Search Projection Service | P0 | B | [x] | [x] | [x] | [x] | [x] | [x] | Index can be rebuilt from PostgreSQL and never acts as final authority for sellable availability. |
| PLAT-02 | Map / Geo Adapter | P0 | B | [x] | [x] | [ ] | [x] | [x] | [x] | Provider is replaceable behind adapter; address precision exposure follows privacy policy. |
| PLAT-03 | Transactional Outbox & Async Jobs | P0 | Supervisor | [x] | [x] | [x] | [x] | [x] | [x] | No domain mutation emits only an in-memory event; retries are idempotent and observable. |
| PLAT-04 | Observability / SRE | P0 | I | [x] | [x] | [x] | [x] | [x] | [x] | Dashboards cover p95 latency, error rate, queue lag, payment reconciliation lag and booking collision errors. |
| PLAT-05 | Security / Risk Controls | P0 | I | [x] | [x] | [x] | [x] | [x] | [x] | Release blocks on critical vulnerabilities, leaked secrets, failed permission-negative tests or missing SBOM. |
| PLAT-06 | Configuration & Feature Flags | P0 | G | [x] | [x] | [x] | [x] | [x] | [x] | Critical features such as paid charter flow can remain OFF independently of deployment. |
| MIG-01 | Legacy WONT/Sixshop Migration | P0 | G | [x] | [x] | [x] | [x] | [x] | [x] | Dry-run reconciliation proves row counts, amounts, media references and URL mappings before cutover. |
| AI-01 | AI Travel Assistant | P1 | G | [x] | [x] | [x] | [x] | [x] | [x] | AI suggestions cite live availability snapshot and require explicit user confirmation before hold/payment. |
| AI-02 | Recommendation & Personalization | P1 | G | [x] | [x] | [x] | [x] | [x] | [x] | Opt-out removes behavioral personalization; ranking never bypasses legal/compliance/availability filters. |
| INT-01 | PMS / Supplier Integrations | P2 | G | [x] | [x] | [x] | [x] | [x] | [x] | External state is reconciled into Jetpool authority rules with clear conflict policy and audit. |

## Open items

Derived by `node scripts/module-status.mjs`; every other module column checks out.

- **STAY-07** Pricing & Quote — events 1/2 — not emitted: quote.expired
- **COMMS-02** Notification Orchestration — events 1/2 — not emitted: notification.requested
- **OPS-04** Analytics & Audit — events 0/1 — not emitted: audit.recorded
- **PLAT-02** Map / Geo Adapter — events 0/1 — not emitted: geo.cache.updated

## Release Gates

| Gate | Criteria | Owner | Status |
|---|---|---|---|
| G0 Spec integrity | All P0 modules have owner, API, data, event, UI and acceptance criteria; No unresolved contract references | Automated (CI) | ✅ PASS |
| G1 Contracts | OpenAPI/AsyncAPI lint pass; Generated client/types compile; Breaking changes explicitly versioned | Automated (CI) | ✅ PASS |
| G2 Data | Migrations up/down or forward-fix tested; Constraints/invariants enabled; Seed data deterministic | Automated (CI) | ✅ PASS |
| G3 Domain | Unit/property/integration tests pass; State transition negative tests pass; Idempotency tests pass | Automated (CI) | ✅ PASS |
| G4 End-to-end | Stay paid flow passes; Exchange bilateral flow passes; Guide free/paid flow passes; Travel order flow passes where enabled | Automated (CI) | ✅ PASS |
| G5 Security | SAST/SCA/secret scan pass; Permission-negative tests pass; AAL2 gates pass; No PAN/CVC storage | Automated (CI) | ✅ PASS |
| G6 Performance | Search/read/write SLO targets meet load-test plan; No oversell under concurrency test | Automated (CI) | ⚪ NOT RUN |
| G7 Migration | Dry-run reconciliation approved; 301 URL map approved; Consent/password migration strategy approved | Automated (CI) | ⚪ NOT RUN |
| G8 DR & Ops | Restore drill successful; Runbooks and alert routes tested; Payment reconciliation tested | Automated (CI) | 🟡 PARTIAL |
| G9 Legal/Business approval | Accommodation/guide/travel/charter gates signed off; Merchant-of-record and settlement policy approved; Terms/privacy/refund policies published | Human (legal/business) | 🔒 REQUIRES HUMAN APPROVAL |
| G10 Production approval | Immutable release artifact; GitHub Environment manual approval; Canary + smoke + rollback readiness | Human (prod approval) | 🔒 REQUIRES HUMAN APPROVAL |

## Invariants (AGENTS_MASTER) — verification test

- [x] I1. PostgreSQL SoT; search/realtime/AI non-authoritative
- [x] I2. Independent Stay/Exchange/Guide FSMs
- [x] I3. Browser success URL never confirms payment
- [x] I4. Webhooks signature-validated, replay-safe, idempotent
- [x] I5. Inventory recheck in tx + durable hold before payment
- [x] I6. Exchange confirm blocks both homes atomically
- [x] I7. Paid publication denied until compliance predicates pass
- [x] I8. No hard-coded universal tax/legal rule
- [x] I9. No PAN/CVC storage
- [x] I10. No global admin read of private messages
- [x] I11. Ledger append-only, double-entry balanced
- [x] I12. Production deploy needs explicit approval




