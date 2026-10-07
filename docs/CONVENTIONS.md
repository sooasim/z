# JETPOOL engineering conventions (binding for every agent and contributor)

Read `dd/AGENTS_MASTER.md` first — its 12 invariants override everything here.

## Layout
```
apps/api/src/platform/   shared primitives (DO NOT fork; extend only via the supervisor)
  config.ts db.ts errors.ts auth.ts crypto.ts context.ts outbox.ts audit.ts fsm.ts
  idempotency.ts inventory.ts ledger.ts payment-subjects.ts notify.ts flags.ts money.ts http.ts jobs.ts realtime.ts
apps/api/src/modules/<module>/index.ts   Fastify plugin: routes + event handlers + adapters + jobs
apps/api/src/modules/<module>/*.ts       service.ts (domain logic), schemas.ts, adapters...
apps/api/test/<module>*.test.ts          vitest, real PostgreSQL (one cloned DB per test file)
packages/db/migrations/NNNN_*.sql        forward-only SQL migrations (checksummed)
apps/web/                                Next.js customer/host/guide/supplier/admin UI
```

## Database
- Schema 0001–0007 is the shared data contract (authored by the Data agent). Never edit an applied migration.
  New tables/columns go in a NEW file in your range:
  core/trust 0100–0199 · stay 0200–0299 · booking 0300–0399 · exchange 0400–0499 · guide 0500–0599 ·
  commerce/finance 0600–0699 · comms/ops/ai 0700–0799 · platform/infra 0800–0899 · QA 0900–0999.
- Use `q / one / maybeOne` from `platform/db.ts` with `$1` parameters only. Never interpolate user input into SQL.
- Mutations run inside `withTx(pool, tx => ...)` or `withIdempotency(...)`. Domain events are written with
  `emit(tx, ctx, ...)` in the SAME tx (transactional outbox).
- Money is integer minor units (`*_minor bigint`), currency `char(3)`. Use `applyBps/allocate` — never floats.

## HTTP
- Routes use zod schemas: `app.withTypeProvider<ZodTypeProvider>().post('/v1/...', { schema: { body, params, querystring, tags: ['STAY-08'] }, preHandler: requireAuth }, handler)`.
  `import type { ZodTypeProvider } from 'fastify-type-provider-zod'`; `import { z } from 'zod'` (zod v4: `z.uuid()`, `z.email()`).
- Always put the module id in `tags` (traceability → generated OpenAPI).
- AuthZ is server-side on every route: `requireAuth`, `requireRole('ADMIN', ...)` (staff roles need AAL2 automatically),
  plus ownership checks in the service (`if (row.host_id !== actor.userId) throw forbidden()`).
- Errors: throw `AppError` helpers from `platform/errors.ts` (`badRequest`, `forbidden`, `notFound`, `conflict`, `unprocessable`).
  PG integrity errors are mapped automatically (exclusion → 409 INVENTORY_UNAVAILABLE etc.).
- Money/inventory-creating POSTs (holds, payments, refunds, orders, exchange confirm, guide booking) REQUIRE
  `Idempotency-Key` via `idempotencyKeyFrom(req)` + `withIdempotency(pool, scope, key, body, fn)`.
- Build a `Ctx` with `ctxFromRequest(req)` and pass it to services. Services must not touch `req`/`reply`.
- Response bodies are JSON objects (`{ item }`, `{ items, nextCursor }`) — camelCase keys in new code is preferred,
  but raw snake_case DB rows are acceptable if consistent within a module. Document the shape in the route schema `response` when practical.

## State machines
- Use `new StateMachine(aggregateType, transitions)` from `platform/fsm.ts`; call `.transition(tx, ctx, { table, id, to, from?, reason, set, versioned })`.
  It does compare-and-set + writes `state_transitions` (actor, reason, correlation id). Never `UPDATE ... SET status` directly.
- Reservation / Exchange / GuideBooking / Payment / Refund / Settlement / Order are separate machines. A domain never
  updates another domain's tables: use exported service functions, the payment-subject contract
  (`platform/payment-subjects.ts`) or outbox events (`onEvent(pattern, consumerName, handler)`).

## Cross-module contracts (owned by the listed module, consumed by others)
| Contract | Owner | Consumers |
|---|---|---|
| `acquireBlock / releaseBlock / convertBlock / isRangeFree` (platform/inventory.ts) | platform | booking, exchange, integrations |
| `registerPaymentSubject(type, handler)` (platform/payment-subjects.ts) | payments | booking (RESERVATION), guide (GUIDE_BOOKING), travel (ORDER) |
| `postLedger / PlatformAccount` (platform/ledger.ts) | finance | payments |
| `notify(tx, ctx, {...})` (platform/notify.ts) | notifications | everyone |
| `evaluatePropertyCompliance(db, propertyId)` exported from `modules/compliance/service.ts` | compliance | properties, booking |
| `ensureConversation(tx, ctx, {contextType, contextId, members})` from `modules/messaging/service.ts` | messaging | booking, exchange, guide, travel |
| `quoteFees(db, {domain, amountMinor, currency})` from `modules/finance/rules.ts` | finance | booking, guide, travel |
| `audit(db, ctx, {...})` (platform/audit.ts) | analytics | everyone (money, permission, compliance, elevated access) |
| `isEnabled / assertEnabled` (platform/flags.ts) | admin | everyone |

If you need a contract owned by another agent that does not exist yet, create the file with the exact exported
signature above and a minimal correct implementation, and note it in your final report; the owner will extend it.

## Feature flags (all OFF by default — G9 legal gates)
`stay.paid_booking`, `exchange.enabled`, `guide.paid`, `travel.commerce`, `charter.direct_booking`, `ai.assistant`,
`ai.recommendations`, `payout.automatic`, `integrations.pms`. Tests enable flags with `enableFlags(t, ...)`.

## Tests (G3/G5)
- `apps/api/test/helpers.ts`: `createTestApp()`, `createUser(t, { roles, aal })`, `call(t, user, method, url, body, headers)`,
  `idem()`, `enableFlags()`, `day(n)`, `t.drain()` (process outbox), `t.runJobs()`.
- Each module needs: happy path, permission-negative (other user / missing role / AAL1 staff), invalid transition,
  idempotency replay, and concurrency where inventory/money is involved.
- Run: `cd apps/api && npx vitest run test/<file>` ; typecheck: `npx tsc -p tsconfig.json --noEmit`.
- PostgreSQL 16 runs locally on localhost:5432 (user postgres, trust auth).

## Security & privacy
- Never log or store secrets, tokens, passwords, raw PAN/CVC, full bank account numbers or ID document images in logs/audit.
- Private messages: participants only; staff need an `elevated_access_grants` row (case-scoped, ≤24h, reason) and every read is audited.
- Exact property address is hidden until a confirmed reservation/exchange.

## Reference module skeleton
```ts
// apps/api/src/modules/favorites/index.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, getActor } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx, q } from '../../platform/db.js';
import { emit } from '../../platform/outbox.js';

export default async function favoritesModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post('/v1/favorites', {
    schema: { tags: ['STAY-05'], body: z.object({ targetType: z.enum(['PROPERTY', 'GUIDE', 'TRAVEL_PRODUCT']), targetId: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const actor = getActor(req); const ctx = ctxFromRequest(req);
    const item = await withTx(app.ctx.pool, async (tx) => {
      const rows = await q(tx, `INSERT INTO favorites(user_id, target_type, target_id) VALUES ($1,$2,$3)
                                ON CONFLICT DO NOTHING RETURNING *`, [actor.userId, req.body.targetType, req.body.targetId]);
      if (rows[0]) await emit(tx, ctx, { aggregateType: 'favorite', aggregateId: actor.userId, eventType: 'favorite.added', payload: req.body });
      return rows[0] ?? null;
    });
    return reply.status(item ? 201 : 200).send({ item });
  });
}
```
