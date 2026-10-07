# JETPOOL v2 상용화 개발 패키지

이 패키지는 첨부 1차 기술 백서를 기반으로 한 2차 구현 명세입니다.

## Start here
1. `JETPOOL_2차_상용화_모듈_아키텍처_기술백서.docx` — 전체 설계와 설명
2. `AGENTS_MASTER.md` — AI가 절대 위반하면 안 되는 규칙
3. `JETPOOL_MASTER_BUILD_SPEC.yaml` — machine-readable module master
4. `JETPOOL_MODULE_TRACEABILITY.csv` — 기능 누락 검산
5. `JETPOOL_OPENAPI_SKELETON.yaml` + `JETPOOL_ASYNCAPI_SKELETON.yaml` — 계약 seed
6. `JETPOOL_DB_SCHEMA_BLUEPRINT.sql` — DB seed
7. `JETPOOL_RELEASE_GATES.yaml` — 출시 gate
8. `diagrams/` — SVG/DOT vector architecture diagrams

## Important
Production deployment must remain protected by explicit approval. Legal/tax/merchant-of-record/charter scope decisions are Release Gates, not AI assumptions.
