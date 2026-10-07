# JETPOOL AI 원클릭 개발 마스터 명세 v2

이 문서는 첨부 1차 기술 백서를 구현 계약으로 재구성한 AI 코딩 오케스트레이션 문서다. “원클릭”은 무인 Production 배포가 아니라 **명세 검증 → 코드/테스트/IaC 생성 → Staging 자동배포 → Release Gate → Production 수동 승인**을 의미한다.

## 1. 입력 파일 우선순위
1. `AGENTS_MASTER.md`
2. `JETPOOL_MASTER_BUILD_SPEC.yaml`
3. `JETPOOL_OPENAPI_SKELETON.yaml` / `JETPOOL_ASYNCAPI_SKELETON.yaml`
4. `JETPOOL_DB_SCHEMA_BLUEPRINT.sql`
5. `JETPOOL_MODULE_TRACEABILITY.csv` / `JETPOOL_UI_ROUTE_MAP.csv`
6. 각 repo의 ADR, OpenAPI, migrations, tests

## 2. 실행 순서
```text
validate-spec → bootstrap-repos → generate-contracts → generate-db → generate-services → generate-web/admin → generate-tests → terraform-plan → deploy-staging → smoke/e2e/load/security → release-report → manual-prod-approval
```

## 3. 병렬 에이전트 분할
- Contracts Agent: API/event/schema/enum만 담당.
- Data Agent: migrations/indexes/constraints/RLS만 담당.
- Booking Agent, Exchange Agent, Guide Agent: 각 FSM과 도메인 불변식만 담당.
- Commerce/Finance Agent: travel/order/payment/ledger/settlement.
- Web UX Agent: public/traveler/host/guide/supplier.
- Admin Agent: compliance/dispute/accounting/audit/CMS.
- Platform Agent: infra/observability/security/outbox/search/realtime.
- QA Agent: contract/integration/E2E/concurrency/security/DR/migration.
각 에이전트는 다른 도메인의 상태를 직접 업데이트하지 않고 계약/이벤트를 통한다.

## 4. 생성 금지 규칙
- 검색 인덱스/Realtime/Redis를 거래 원장으로 사용 금지.
- client amount/payment redirect를 신뢰하여 예약 확정 금지.
- Exchange를 Reservation 테이블 한 상태로 합치기 금지.
- 관리자 전체 메시지 무제한 열람 금지.
- 세율/인허가/가이드 자격을 추정하여 하드코딩 금지.
- 카드 PAN/CVC 저장 금지.
- Production 무승인 자동배포 금지.

## 5. 구현 루프
각 모듈마다 다음 산출물을 생성한 뒤 다음 모듈로 진행한다: `ADR → API schema → migration → domain code → policy → UI route → tests → observability → docs`. 실패 시 해당 모듈만 롤백하고 계약 변경부터 다시 시작한다.

## 6. 완료 판정
모든 P0 모듈이 `G0~G10` 중 자신에게 적용되는 Gate를 통과하고, 세 대표 E2E 사슬(유료숙박 / Home Exchange / Guide Friend)이 감사로그와 재무원장까지 끝단에서 대사되면 상용 출시 후보로 판정한다.
