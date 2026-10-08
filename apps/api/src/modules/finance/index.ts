import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAal2, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import { conflict, forbidden, notFound } from '../../platform/errors.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { StateMachine, recordTransition } from '../../platform/fsm.js';
import { currencySchema, minorSchema } from '../../platform/money.js';
import { cursorColumns, decodeCursor, idParams, isoDate, page, pagination } from '../../platform/http.js';
import { postPgSettlement, trialBalance } from './ledger.js';
import { MockPayoutProvider, payoutCsv } from './payouts.js';
import { FEE_JURISDICTION, quoteFees } from './rules.js';
import {
  SettlementFSM,
  approveSettlement,
  executePayout,
  generateSettlements,
  markSettlementPaid,
  settlementDto,
  type SettlementRow,
} from './settlement.js';

const T_LEDGER = 'FIN-01';
const T_SETTLE = 'FIN-02';
const T_RULES = 'FIN-03';

export const FinanceRuleFSM = new StateMachine<'DRAFT' | 'APPROVED' | 'RETIRED'>('finance_rule', {
  DRAFT: ['APPROVED', 'RETIRED'],
  APPROVED: ['RETIRED'],
  RETIRED: [],
});

const datetime = z.iso.datetime({ offset: true });
const ruleBody = z
  .object({
    ruleType: z.enum(['PLATFORM_FEE', 'HOST_FEE', 'TAX', 'WITHHOLDING', 'EVIDENCE']),
    domain: z.enum(['STAY', 'GUIDE', 'TRAVEL', 'EXCHANGE', '*']),
    jurisdiction: z.string().regex(/^[A-Z]{2}$/).default(FEE_JURISDICTION),
    params: z.record(z.string(), z.unknown()),
    effectiveFrom: datetime,
    effectiveUntil: datetime.optional().nullable(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((v, c) => {
    if (['PLATFORM_FEE', 'HOST_FEE', 'TAX', 'WITHHOLDING'].includes(v.ruleType)) {
      const bps = v.params.bps;
      const flat = v.params.flat_minor;
      const okBps = Number.isInteger(bps) && (bps as number) >= 0 && (bps as number) <= 10000;
      const okFlat = Number.isInteger(flat) && (flat as number) >= 0;
      if (!okBps && !okFlat) c.addIssue({ code: 'custom', path: ['params'], message: 'params.bps (0..10000) or params.flat_minor (>=0 integer) is required' });
      if (v.params.base !== undefined && !['TOTAL', 'FEES', 'PLATFORM_FEE'].includes(String(v.params.base))) c.addIssue({ code: 'custom', path: ['params', 'base'], message: 'base must be TOTAL, FEES or PLATFORM_FEE' });
    }
    if (v.effectiveUntil && new Date(v.effectiveUntil) <= new Date(v.effectiveFrom)) c.addIssue({ code: 'custom', path: ['effectiveUntil'], message: 'effectiveUntil must be after effectiveFrom' });
  });

const ruleDto = (r: any) => ({
  id: r.id,
  ruleType: r.rule_type,
  domain: r.domain,
  jurisdiction: r.jurisdiction,
  params: r.params,
  effectiveFrom: r.effective_from,
  effectiveUntil: r.effective_until,
  status: r.status,
  createdBy: r.created_by,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  retireRequestedBy: r.retire_requested_by ?? null,
  retireRequestedAt: r.retire_requested_at ?? null,
  retireReason: r.retire_reason ?? null,
  retiredBy: r.retired_by ?? null,
  note: r.note,
  createdAt: r.created_at,
});

const payoutAccountDto = (a: any) => ({
  id: a.id,
  userId: a.user_id,
  bankCode: a.bank_code,
  accountLast4: a.account_last4,
  holderName: a.holder_name,
  status: a.status,
  createdAt: a.created_at,
});

/** FIN-01..03 Ledger, Settlement & Payout, Fee/Tax rules — routes, event handlers and adapters are registered here. */
export default async function financeModule(app: FastifyInstance) {
  if (!app.ctx.adapters.has('payouts.provider') && app.ctx.config.NODE_ENV !== 'production') {
    app.ctx.adapters.set('payouts.provider', new MockPayoutProvider());
  }
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  const accounting = requireRole('ACCOUNTING', 'ADMIN');

  // ------------------------------------------------------------------ FIN-03 rules
  r.get(
    '/v1/finance/rules',
    { schema: { tags: [T_RULES], querystring: z.object({ status: z.enum(['DRAFT', 'APPROVED', 'RETIRED']).optional(), ruleType: z.string().optional(), domain: z.string().optional() }) }, preHandler: accounting },
    async (req) => {
      const rows = await q(
        pool,
        `SELECT * FROM finance_rules WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR rule_type = $2) AND ($3::text IS NULL OR domain = $3)
         ORDER BY rule_type, domain, effective_from DESC LIMIT 500`,
        [req.query.status ?? null, req.query.ruleType ?? null, req.query.domain ?? null],
      );
      return { items: rows.map(ruleDto) };
    },
  );

  r.post('/v1/finance/rules', { schema: { tags: [T_RULES], body: ruleBody }, preHandler: accounting }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const b = req.body;
    const row = await withTx(pool, async (tx) => {
      const rule = await one(
        tx,
        `INSERT INTO finance_rules(rule_type, domain, jurisdiction, params, effective_from, effective_until, status, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8) RETURNING *`,
        [b.ruleType, b.domain, b.jurisdiction, JSON.stringify(b.params), b.effectiveFrom, b.effectiveUntil ?? null, b.note ?? null, ctx.actor!.userId],
      );
      await recordTransition(tx, ctx, { aggregateType: 'finance_rule', aggregateId: rule.id, from: null, to: 'DRAFT', reason: 'CREATED' });
      await audit(tx, ctx, { action: 'finance.rule.create', resourceType: 'finance_rule', resourceId: rule.id, category: 'MONEY', after: ruleDto(rule) });
      await emit(tx, ctx, { aggregateType: 'finance_rule', aggregateId: rule.id, eventType: 'finance.rule.changed', payload: { ruleId: rule.id, status: 'DRAFT' } });
      return rule;
    });
    return reply.status(201).send({ item: ruleDto(row) });
  });

  r.post('/v1/finance/rules/:id/approve', { schema: { tags: [T_RULES], params: idParams }, preHandler: accounting }, async (req) => {
    const ctx = ctxFromRequest(req);
    const actor = getActor(req);
    const row = await withTx(pool, async (tx) => {
      const rule = await maybeOne(tx, `SELECT * FROM finance_rules WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!rule) throw notFound('Finance rule');
      if (rule.created_by && rule.created_by === actor.userId) throw forbidden('MAKER_CHECKER_VIOLATION', 'The creator of a rule cannot approve it');
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`finance_rule:${rule.rule_type}:${rule.domain}:${rule.jurisdiction}`]);
      const overlap = await maybeOne(
        tx,
        `SELECT id FROM finance_rules WHERE status = 'APPROVED' AND rule_type = $1 AND domain = $2 AND jurisdiction = $3 AND id <> $4
            AND tstzrange(effective_from, effective_until) && tstzrange($5::timestamptz, $6::timestamptz) LIMIT 1`,
        [rule.rule_type, rule.domain, rule.jurisdiction, rule.id, rule.effective_from, rule.effective_until],
      );
      if (overlap) throw conflict('RULE_OVERLAP', 'An approved rule already covers part of this effective window', { ruleId: overlap.id });
      const { row: approved } = await FinanceRuleFSM.transition(tx, ctx, {
        table: 'finance_rules',
        id: rule.id,
        from: 'DRAFT',
        to: 'APPROVED',
        reason: 'APPROVED',
        set: { approved_by: actor.userId, approved_at: new Date() },
      });
      await audit(tx, ctx, { action: 'finance.rule.approve', resourceType: 'finance_rule', resourceId: rule.id, category: 'MONEY', before: ruleDto(rule), after: ruleDto(approved) });
      await emit(tx, ctx, { aggregateType: 'finance_rule', aggregateId: rule.id, eventType: 'finance.rule.changed', payload: { ruleId: rule.id, status: 'APPROVED' } });
      return approved;
    });
    return { item: ruleDto(row) };
  });

  /**
   * Retiring a DRAFT rule is one step. Retiring an APPROVED rule switches a fee / tax component off for new quotes, so it
   * is maker-checker like the approval (invariant 8): the first call records a retire request (202, rule stays
   * APPROVED); a DIFFERENT ACCOUNTING/ADMIN user confirms it with a second call. The requester cannot confirm.
   */
  r.post(
    '/v1/finance/rules/:id/retire',
    { schema: { tags: [T_RULES], params: idParams, body: z.object({ reason: z.string().min(3).max(500) }) }, preHandler: accounting },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const actor = getActor(req);
      const out = await withTx(pool, async (tx) => {
        const rule = await maybeOne(tx, `SELECT * FROM finance_rules WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!rule) throw notFound('Finance rule');
        if (rule.status === 'APPROVED' && !rule.retire_requested_by) {
          const requested = await one(
            tx,
            `UPDATE finance_rules SET retire_requested_by = $2, retire_requested_at = now(), retire_reason = $3 WHERE id = $1 RETURNING *`,
            [rule.id, actor.userId, req.body.reason],
          );
          await audit(tx, ctx, { action: 'finance.rule.retire_requested', resourceType: 'finance_rule', resourceId: rule.id, category: 'MONEY', reason: req.body.reason, before: ruleDto(rule), after: ruleDto(requested) });
          await emit(tx, ctx, { aggregateType: 'finance_rule', aggregateId: rule.id, eventType: 'finance.rule.retire_requested', payload: { ruleId: rule.id, requestedBy: actor.userId } });
          return { status: 202, row: requested, pending: true };
        }
        if (rule.status === 'APPROVED' && rule.retire_requested_by === actor.userId) {
          throw forbidden('MAKER_CHECKER_VIOLATION', 'The requester of a retirement cannot confirm it; another ACCOUNTING/ADMIN user must');
        }
        const { row } = await FinanceRuleFSM.transition(tx, ctx, {
          table: 'finance_rules',
          id: rule.id,
          to: 'RETIRED',
          reason: req.body.reason,
          set: { retired_by: actor.userId },
        });
        await audit(tx, ctx, { action: 'finance.rule.retire', resourceType: 'finance_rule', resourceId: rule.id, category: 'MONEY', reason: req.body.reason, before: ruleDto(rule), after: ruleDto(row) });
        await emit(tx, ctx, { aggregateType: 'finance_rule', aggregateId: rule.id, eventType: 'finance.rule.changed', payload: { ruleId: rule.id, status: 'RETIRED' } });
        return { status: 200, row, pending: false };
      });
      return reply.status(out.status).send({ item: ruleDto(out.row), ...(out.pending ? { pending: true, code: 'RETIRE_CONFIRMATION_REQUIRED' } : {}) });
    },
  );

  r.post(
    '/v1/finance/rules/:id/retire/cancel',
    { schema: { tags: [T_RULES], params: idParams, summary: 'Withdraw a pending retire request of an APPROVED rule' }, preHandler: accounting },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const rule = await maybeOne(tx, `SELECT * FROM finance_rules WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!rule) throw notFound('Finance rule');
        if (rule.status !== 'APPROVED' || !rule.retire_requested_by) throw conflict('NO_RETIRE_REQUEST', 'This rule has no pending retire request');
        const after = await one(tx, `UPDATE finance_rules SET retire_requested_by = NULL, retire_requested_at = NULL, retire_reason = NULL WHERE id = $1 RETURNING *`, [rule.id]);
        await audit(tx, ctx, { action: 'finance.rule.retire_request_cancelled', resourceType: 'finance_rule', resourceId: rule.id, category: 'MONEY', before: ruleDto(rule), after: ruleDto(after) });
        return after;
      });
      return { item: ruleDto(row) };
    },
  );

  r.get(
    '/v1/finance/quote',
    {
      schema: { tags: [T_RULES], summary: 'Preview fees for an amount with the currently approved rules', querystring: z.object({ domain: z.enum(['STAY', 'GUIDE', 'TRAVEL', 'EXCHANGE']), amountMinor: z.coerce.number().int().nonnegative(), currency: currencySchema.default('KRW') }) },
      preHandler: accounting,
    },
    async (req) => ({ item: await quoteFees(pool, req.query) }),
  );

  r.get('/v1/receipts', { schema: { tags: [T_RULES], querystring: pagination }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT id, payment_id, receipt_type, amount_minor, currency, data, issued_at, issued_at AS created_at, ${cursorColumns(undefined, 'issued_at')} FROM receipts
        WHERE user_id = $1 AND ($2::timestamptz IS NULL OR (issued_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY issued_at DESC, id DESC LIMIT $4`,
      [actor.userId, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    const p = page(rows, req.query.limit);
    return {
      items: p.items.map((x: any) => ({ id: x.id, paymentId: x.payment_id, receiptType: x.receipt_type, amountMinor: x.amount_minor, currency: x.currency, data: x.data, issuedAt: x.issued_at })),
      nextCursor: p.nextCursor,
    };
  });

  // ------------------------------------------------------------------ FIN-01 ledger (admin read + PG settlement)
  r.get('/v1/admin/ledger/accounts', { schema: { tags: [T_LEDGER], querystring: z.object({ currency: z.string().optional(), ownerId: z.uuid().optional() }) }, preHandler: accounting }, async (req) => {
    const rows = await q(
      pool,
      `SELECT b.account_id AS id, b.code, b.account_type, b.currency, b.debit_minor::bigint AS debit_minor, b.credit_minor::bigint AS credit_minor, b.balance_minor::bigint AS balance_minor,
              a.owner_type, a.owner_id, a.purpose
         FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
        WHERE ($1::text IS NULL OR b.currency = $1) AND ($2::uuid IS NULL OR a.owner_id = $2) ORDER BY b.currency, b.code LIMIT 1000`,
      [req.query.currency ?? null, req.query.ownerId ?? null],
    );
    return { items: rows };
  });

  r.get(
    '/v1/admin/ledger/transactions',
    { schema: { tags: [T_LEDGER], querystring: pagination.extend({ sourceType: z.string().optional(), sourceId: z.uuid().optional(), type: z.string().optional() }) }, preHandler: accounting },
    async (req) => {
      const c = decodeCursor(req.query.cursor);
      const txs = await q(
        pool,
        `SELECT *, ${cursorColumns()} FROM ledger_transactions WHERE ($1::text IS NULL OR source_type = $1) AND ($2::uuid IS NULL OR source_id = $2) AND ($3::text IS NULL OR transaction_type = $3)
           AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $6`,
        [req.query.sourceType ?? null, req.query.sourceId ?? null, req.query.type ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
      );
      const p = page(txs, req.query.limit);
      const ids = p.items.map((t: any) => t.id);
      const entries = ids.length
        ? await q(
            pool,
            `SELECT e.transaction_id, a.code, e.debit_minor, e.credit_minor, e.currency FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
              WHERE e.transaction_id = ANY($1::uuid[]) ORDER BY e.transaction_id, a.code`,
            [ids],
          )
        : [];
      return {
        items: p.items.map((t: any) => ({
          id: t.id,
          type: t.transaction_type,
          sourceType: t.source_type,
          sourceId: t.source_id,
          reversesTransactionId: t.reverses_transaction_id,
          memo: t.memo,
          createdAt: t.created_at,
          entries: entries.filter((e: any) => e.transaction_id === t.id).map((e: any) => ({ account: e.code, debitMinor: e.debit_minor, creditMinor: e.credit_minor, currency: e.currency })),
        })),
        nextCursor: p.nextCursor,
      };
    },
  );

  r.get('/v1/admin/ledger/trial-balance', { schema: { tags: [T_LEDGER] }, preHandler: accounting }, async () => trialBalance(pool));

  r.post(
    '/v1/admin/ledger/pg-settlements',
    {
      schema: { tags: [T_LEDGER], summary: 'Record PG funds landing in the bank (Dr BANK / Cr PG_CLEARING)', body: z.object({ currency: currencySchema, amountMinor: minorSchema.positive(), reference: z.string().min(3).max(120) }) },
      preHandler: requireRole('ACCOUNTING'),
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req);
      const res = await withIdempotency(pool, 'finance.pg-settlement', key, req.body, async (tx) => {
        const out = await postPgSettlement(tx, ctx, req.body);
        await audit(tx, ctx, { action: 'ledger.pg_settlement', resourceType: 'ledger_transaction', resourceId: out.transactionId, category: 'MONEY', after: req.body });
        await emit(tx, ctx, { aggregateType: 'ledger', aggregateId: out.transactionId, eventType: 'ledger.posted', payload: { transactionId: out.transactionId, type: 'PG_SETTLEMENT' } });
        return { status: out.created ? 201 : 200, body: { item: out } };
      });
      return reply.status(res.status).send(res.body);
    },
  );

  // ------------------------------------------------------------------ FIN-02 payout accounts
  r.post(
    '/v1/payout-accounts',
    {
      schema: {
        tags: [T_SETTLE],
        summary: 'Register a tokenized payout account (AAL2). Full account numbers are never accepted.',
        body: z.object({
          bankCode: z.string().regex(/^[0-9A-Z]{2,10}$/),
          accountLast4: z.string().regex(/^\d{4}$/),
          accountToken: z
            .string()
            .min(8)
            .max(200)
            .regex(/^[A-Za-z0-9_\-:.]+$/)
            .refine((s) => !/^\d{8,}$/.test(s.replace(/[-.]/g, '')), 'accountToken must be a provider token, not an account number'),
          holderName: z.string().trim().min(1).max(100),
        }),
      },
      preHandler: [requireAuth, requireAal2],
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const actor = getActor(req);
      const b = req.body;
      const row = await withTx(pool, async (tx) => {
        const acc = await one(
          tx,
          `INSERT INTO payout_accounts(user_id, bank_code, account_last4, account_token, holder_name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.userId, b.bankCode, b.accountLast4, b.accountToken, b.holderName],
        );
        await audit(tx, ctx, { action: 'payout_account.create', resourceType: 'payout_account', resourceId: acc.id, category: 'MONEY', after: { bankCode: b.bankCode, accountLast4: b.accountLast4 } });
        return acc;
      });
      return reply.status(201).send({ item: payoutAccountDto(row) });
    },
  );

  r.get('/v1/payout-accounts', { schema: { tags: [T_SETTLE] }, preHandler: requireAuth }, async (req) => {
    const rows = await q(pool, `SELECT * FROM payout_accounts WHERE user_id = $1 ORDER BY created_at DESC`, [getActor(req).userId]);
    return { items: rows.map(payoutAccountDto) };
  });

  r.post(
    '/v1/admin/payout-accounts/:id/verify',
    { schema: { tags: [T_SETTLE], params: idParams, body: z.object({ decision: z.enum(['VERIFIED', 'REJECTED', 'DISABLED']).default('VERIFIED') }) }, preHandler: accounting },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const before = await maybeOne(tx, `SELECT * FROM payout_accounts WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!before) throw notFound('Payout account');
        const after = await one(tx, `UPDATE payout_accounts SET status = $2 WHERE id = $1 RETURNING *`, [req.params.id, req.body.decision]);
        await audit(tx, ctx, { action: 'payout_account.verify', resourceType: 'payout_account', resourceId: req.params.id, category: 'MONEY', before: { status: before.status }, after: { status: after.status } });
        return after;
      });
      return { item: payoutAccountDto(row) };
    },
  );

  // ------------------------------------------------------------------ FIN-02 settlements
  r.post(
    '/v1/admin/settlements/generate',
    { schema: { tags: [T_SETTLE], body: z.object({ periodStart: isoDate, periodEnd: isoDate }) }, preHandler: accounting },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req, false);
      const res = await withIdempotency(pool, `finance.settlements.generate:${ctx.actor!.userId}`, key, req.body, async (tx) => ({
        status: 201,
        body: await generateSettlements(tx, ctx, req.body),
      }));
      return reply.status(res.status).send(res.body);
    },
  );

  r.get(
    '/v1/admin/settlements',
    { schema: { tags: [T_SETTLE], querystring: pagination.extend({ status: z.string().optional(), payeeId: z.uuid().optional() }) }, preHandler: accounting },
    async (req) => {
      const c = decodeCursor(req.query.cursor);
      const rows = await q<SettlementRow>(
        pool,
        `SELECT *, ${cursorColumns()} FROM settlements WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR payee_id = $2)
           AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [req.query.status ?? null, req.query.payeeId ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
      );
      const p = page(rows, req.query.limit);
      return { items: p.items.map(settlementDto), nextCursor: p.nextCursor };
    },
  );

  r.get('/v1/admin/settlements/payout-export', { schema: { tags: [T_SETTLE], summary: 'Manual bank-transfer CSV for PAYOUT_PENDING settlements' }, preHandler: requireRole('ACCOUNTING') }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const rows = await q(
      pool,
      `SELECT s.id AS settlement_id, s.payee_id, a.bank_code, a.account_last4, a.account_token, a.holder_name, s.net_minor, s.currency
         FROM settlements s JOIN payout_accounts a ON a.id = s.payout_account_id WHERE s.status = 'PAYOUT_PENDING' ORDER BY s.created_at`,
    );
    await audit(pool, ctx, { action: 'settlement.payout_export', resourceType: 'settlement', category: 'MONEY', after: { count: rows.length } });
    return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="payouts.csv"').send(payoutCsv(rows as any));
  });

  r.get('/v1/admin/settlements/:id', { schema: { tags: [T_SETTLE], params: idParams }, preHandler: accounting }, async (req) => {
    const s = await maybeOne<SettlementRow>(pool, `SELECT * FROM settlements WHERE id = $1`, [req.params.id]);
    if (!s) throw notFound('Settlement');
    const items = await q(pool, `SELECT * FROM settlement_items WHERE settlement_id = $1 ORDER BY source_type, source_id`, [s.id]);
    return { item: { ...settlementDto(s), items } };
  });

  r.post('/v1/admin/settlements/:id/approve', { schema: { tags: [T_SETTLE], params: idParams }, preHandler: requireRole('ACCOUNTING') }, async (req) => {
    const ctx = ctxFromRequest(req);
    const row = await withTx(pool, (tx) => approveSettlement(tx, ctx, req.params.id));
    return { item: settlementDto(row) };
  });

  r.post('/v1/admin/settlements/:id/payout', { schema: { tags: [T_SETTLE], params: idParams }, preHandler: requireRole('ACCOUNTING') }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const key = idempotencyKeyFrom(req);
    const res = await withIdempotency(pool, `finance.settlement.payout:${req.params.id}`, key, {}, async (tx) => ({ body: await executePayout(tx, ctx, req.params.id) }));
    return reply.status(res.status).send(res.body);
  });

  r.post(
    '/v1/admin/settlements/:id/mark-paid',
    { schema: { tags: [T_SETTLE], params: idParams, body: z.object({ payoutRef: z.string().min(3).max(200) }) }, preHandler: requireRole('ACCOUNTING') },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req);
      const res = await withIdempotency(pool, `finance.settlement.mark-paid:${req.params.id}`, key, req.body, async (tx) => ({
        body: { item: settlementDto(await markSettlementPaid(tx, ctx, req.params.id, req.body.payoutRef)) },
      }));
      return reply.status(res.status).send(res.body);
    },
  );

  r.post('/v1/admin/settlements/:id/reconcile', { schema: { tags: [T_SETTLE], params: idParams }, preHandler: requireRole('ACCOUNTING') }, async (req) => {
    const ctx = ctxFromRequest(req);
    const row = await withTx(pool, async (tx) => {
      const { row } = await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: req.params.id, from: 'PAID', to: 'RECONCILED', reason: 'BANK_RECONCILED' });
      await emit(tx, ctx, { aggregateType: 'settlement', aggregateId: req.params.id, eventType: 'payout.reconciled', payload: { settlementId: req.params.id } });
      await audit(tx, ctx, { action: 'settlement.reconcile', resourceType: 'settlement', resourceId: req.params.id, category: 'MONEY' });
      return row;
    });
    return { item: settlementDto(row) };
  });

  r.post(
    '/v1/admin/settlements/:id/hold',
    { schema: { tags: [T_SETTLE], params: idParams, body: z.object({ reason: z.string().min(3).max(300) }) }, preHandler: accounting },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const { row } = await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: req.params.id, to: 'HELD', reason: req.body.reason, set: { hold_reason: req.body.reason } });
        await audit(tx, ctx, { action: 'settlement.hold', resourceType: 'settlement', resourceId: req.params.id, category: 'MONEY', reason: req.body.reason });
        return row;
      });
      return { item: settlementDto(row) };
    },
  );

  r.post(
    '/v1/admin/settlements/:id/release',
    { schema: { tags: [T_SETTLE], params: idParams, body: z.object({ reason: z.string().min(3).max(300) }) }, preHandler: accounting },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: req.params.id, from: 'HELD', to: 'READY', reason: req.body.reason, set: { hold_reason: null } });
        const { row } = await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: req.params.id, from: 'READY', to: 'APPROVAL_PENDING', reason: 'RESUBMITTED' });
        await audit(tx, ctx, { action: 'settlement.release', resourceType: 'settlement', resourceId: req.params.id, category: 'MONEY', reason: req.body.reason });
        return row;
      });
      return { item: settlementDto(row) };
    },
  );

  // payee earnings statements (host / guide / supplier) — ledger-derived
  r.get('/v1/provider/settlements', { schema: { tags: [T_SETTLE], querystring: pagination }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const c = decodeCursor(req.query.cursor);
    const rows = await q<SettlementRow>(
      pool,
      `SELECT *, ${cursorColumns()} FROM settlements WHERE payee_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [actor.userId, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    const p = page(rows, req.query.limit);
    const ids = p.items.map((s) => s.id);
    const items = ids.length
      ? await q(pool, `SELECT settlement_id, source_type, source_id, gross_minor, fee_minor, refund_minor, currency FROM settlement_items WHERE settlement_id = ANY($1::uuid[])`, [ids])
      : [];
    const balances = await q(
      pool,
      `SELECT b.code, b.currency, b.balance_minor::bigint AS balance_minor, a.purpose FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1 ORDER BY b.code`,
      [actor.userId],
    );
    return {
      items: p.items.map((s) => ({
        ...settlementDto(s),
        lines: items
          .filter((i: any) => i.settlement_id === s.id)
          .map((i: any) => ({ sourceType: i.source_type, sourceId: i.source_id, grossMinor: i.gross_minor, feeMinor: i.fee_minor, refundMinor: i.refund_minor, netMinor: i.gross_minor - i.fee_minor - i.refund_minor })),
      })),
      balances: balances.map((b: any) => ({ account: b.code, purpose: b.purpose, currency: b.currency, balanceMinor: b.balance_minor })),
      nextCursor: p.nextCursor,
    };
  });

}
