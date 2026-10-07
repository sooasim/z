# ADR-0001 — Modular monolith: 8 logical repos as bounded-context modules in one monorepo

- Status: Accepted · Date: 2026-10-07 · Deciders: Supervisor, Platform, domain leads
- Spec: `dd/JETPOOL_MASTER_BUILD_SPEC.yaml` (`architecture.repos`), `dd/AGENTS_MASTER.md` invariant 2

## Context
The spec names eight logical repositories (jetpool-web, -api, -booking, -exchange, -guide, -admin, -contracts,
-infra). Splitting them physically on day one would multiply CI/CD pipelines, versioned client releases and
distributed-transaction problems (hold → payment → confirmation → ledger) before there is traffic to justify it.
At the same time Paid Stay, Home Exchange and Guide Friend must keep **independent state machines** and must not
reach into each other's tables.

## Decision
One pnpm monorepo, one deployable API image (api + worker + migrate commands) and one web image:

| Logical repo | Location |
|---|---|
| jetpool-api / -booking / -exchange / -guide / -admin | `apps/api/src/modules/<context>` (Fastify plugins) |
| jetpool-web | `apps/web` (Next.js) |
| jetpool-contracts | generated `packages/contracts/openapi.json` (from route zod schemas) + `dd/*` seeds |
| jetpool-infra | `infra/`, `.github/`, `scripts/`, `docs/runbooks` |

Module boundaries are enforced by convention and review (`docs/CONVENTIONS.md`):
- A module only writes its own tables. Cross-context effects go through **exported service contracts**
  (e.g. `evaluatePropertyCompliance`, `ensureConversation`, `quoteFees`), the **payment-subject registry**
  (`registerPaymentSubject('RESERVATION' | 'GUIDE_BOOKING' | 'ORDER', handler)` — payments never import booking) or
  **transactional outbox events** (`emit` in the same transaction, `onEvent` consumers deduplicated per consumer).
- Every route carries its module id in `tags` → traceability from spec to OpenAPI (G0/G1).
- Each FSM is a separate `StateMachine` instance writing `state_transitions`.

## Consequences
- + Single transaction where the business needs it (hold + payment record), single CI, simple local dev.
- + Contracts are already the seams: extracting e.g. booking into a service later means replacing in-process calls
  with HTTP/queue adapters behind the same signatures; outbox events already are the integration events.
- − Discipline is required to avoid cross-module table access; reviewers check imports of other modules'
  internals. A lint rule (dependency-cruiser) is a planned follow-up.
- − One image scales api and worker together per release (separate services/process counts mitigate this).

## Revisit when
A context needs an independent release cadence or scaling profile (e.g. search/AI), or team count > ~4 squads.
