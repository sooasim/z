import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, hasRole, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx } from '../../platform/context.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import { badRequest, conflict, notFound } from '../../platform/errors.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { assertEnabled } from '../../platform/flags.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { recordTransition } from '../../platform/fsm.js';
import { registerJob } from '../../platform/jobs.js';
import { currencySchema, minorSchema } from '../../platform/money.js';
import { cursorColumns, decodeCursor, idParams, isoDate, page, pagination } from '../../platform/http.js';
import { grantRole } from '../roles/service.js';
import {
  DepartureFSM,
  ProductFSM,
  SupplierFSM,
  auditSupplierDecision,
  cancelDeparture,
  cancelOrder,
  createOrder,
  expireOrders,
  loadOrder,
  orderDto,
  registerOrderPaymentSubject,
  runDepartureLifecycle,
  supplierOf,
  supplierOrderView,
} from './service.js';

const T1 = 'TRAVEL-01';
const T2 = 'TRAVEL-02';
const T3 = 'TRAVEL-03';
const T4 = 'TRAVEL-04';
const datetime = z.iso.datetime({ offset: true });
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const productType = z.enum(['TOUR', 'TICKET', 'ACTIVITY', 'PACKAGE']);
const tiers = z.array(z.object({ min_hours_before: z.number().int().min(0), refund_pct: z.number().int().min(0).max(100) })).max(10);
const cancellationTerms = z.object({ tiers: tiers.optional(), fee_refundable: z.boolean().optional(), note: z.string().max(2000).optional() });
const optionInput = z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(200), priceMinor: minorSchema, active: z.boolean().default(true) });
const productBase = {
  type: productType,
  title: z.string().trim().min(2).max(200),
  summary: z.string().max(1000).optional().nullable(),
  description: z.string().max(20000).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  durationMinutes: z.number().int().positive().max(60 * 24 * 60).optional().nullable(),
  basePriceMinor: minorSchema.optional().nullable(),
  currency: currencySchema.optional(),
  cancellationTerms: cancellationTerms.optional(),
  mediaIds: z.array(z.uuid()).max(50).optional(),
  options: z.array(optionInput).max(50).optional(),
};
const ITEM_REF_TABLE: Record<string, string | null> = {
  STAY: 'properties',
  EXCHANGE: 'exchange_requests',
  GUIDE: 'guide_profiles',
  TRAVEL_PRODUCT: 'travel_products',
  NOTE: null,
  TRANSPORT: null,
};

const supplierDto = (s: any) => ({
  id: s.id,
  ownerUserId: s.owner_user_id,
  name: s.name,
  supplierType: s.supplier_type,
  businessProfileId: s.business_profile_id,
  merchantOfRecord: s.merchant_of_record,
  commissionBps: s.commission_bps,
  status: s.status,
  createdAt: s.created_at,
});

const productDto = (p: any, extra: Record<string, unknown> = {}) => ({
  id: p.id,
  supplierId: p.supplier_id,
  type: p.type,
  slug: p.slug,
  title: p.title,
  summary: p.summary,
  description: p.description,
  city: p.city,
  country: p.country,
  durationMinutes: p.duration_minutes,
  basePriceMinor: p.base_price_minor,
  currency: p.currency,
  cancellationTerms: p.cancellation_terms,
  mediaIds: p.media_ids,
  status: p.status,
  // TRAVEL-01 acceptance: published product identifies seller and merchant-of-record role
  seller: p.supplier_name !== undefined ? { supplierId: p.supplier_id, name: p.supplier_name, merchantOfRecord: p.merchant_of_record } : undefined,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  ...extra,
});

const departureDto = (d: any) => ({
  id: d.id,
  productId: d.product_id,
  startsAt: d.starts_at,
  endsAt: d.ends_at,
  capacity: d.capacity,
  booked: d.booked,
  remaining: Math.max(0, d.capacity - d.booked),
  minParticipants: d.min_participants,
  cutoffAt: d.cutoff_at,
  priceMinor: d.price_minor,
  status: d.status,
  guaranteed: d.status === 'GUARANTEED',
});

const itemDto = (i: any) => ({
  id: i.id,
  dayIndex: i.day_index,
  sortOrder: i.sort_order,
  itemType: i.item_type,
  refId: i.ref_id,
  title: i.title,
  startTime: i.start_time,
  endTime: i.end_time,
  note: i.note,
});

/** TRAVEL-01..04 Travel Catalog, Departures, Itinerary, Orders — routes, event handlers and adapters are registered here. */
export default async function travelModule(app: FastifyInstance) {
  registerOrderPaymentSubject();
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  async function upsertOptions(tx: any, productId: string, options: z.infer<typeof optionInput>[]) {
    const keep: string[] = [];
    for (const o of options) {
      if (o.id) {
        const row = await maybeOne(tx, `UPDATE travel_product_options SET name = $3, price_minor = $4, active = $5 WHERE id = $1 AND product_id = $2 RETURNING id`, [
          o.id,
          productId,
          o.name,
          o.priceMinor,
          o.active,
        ]);
        if (!row) throw badRequest('INVALID_OPTION', `Option ${o.id} does not belong to this product`);
        keep.push(row.id);
      } else {
        const row = await one(tx, `INSERT INTO travel_product_options(product_id, name, price_minor, active) VALUES ($1,$2,$3,$4) RETURNING id`, [productId, o.name, o.priceMinor, o.active]);
        keep.push(row.id);
      }
    }
    // options are never deleted (orders reference them): missing ones are deactivated
    await tx.query(`UPDATE travel_product_options SET active = false WHERE product_id = $1 AND NOT (id = ANY($2::uuid[]))`, [productId, keep]);
  }

  /** Canonical text of everything a buyer sees of a product (columns + options); jsonb text output is key-ordered. */
  async function productContent(db: any, id: string): Promise<string> {
    const row = await one<{ c: string }>(
      db,
      `SELECT ((to_jsonb(p) - 'status' - 'slug' - 'created_at' - 'updated_at')
               || jsonb_build_object('options', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price', o.price_minor, 'active', o.active) ORDER BY o.id), '[]'::jsonb)
                                                   FROM travel_product_options o WHERE o.product_id = p.id)))::text AS c
         FROM travel_products p WHERE p.id = $1`,
      [id],
    );
    return row.c;
  }

  async function productWithOptions(db: any, id: string) {
    const p = await maybeOne(db, `SELECT p.*, s.name AS supplier_name, s.merchant_of_record, s.status AS supplier_status, s.owner_user_id FROM travel_products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [id]);
    if (!p) return null;
    const options = await q(db, `SELECT id, name, price_minor, active FROM travel_product_options WHERE product_id = $1 ORDER BY price_minor, name`, [id]);
    return { row: p, options: options.map((o: any) => ({ id: o.id, name: o.name, priceMinor: o.price_minor, active: o.active })) };
  }

  // ------------------------------------------------------------------ TRAVEL-01 suppliers
  r.post(
    '/v1/suppliers',
    {
      schema: { summary: 'Apply as a travel supplier',
        tags: [T1],
        body: z.object({
          name: z.string().trim().min(2).max(200),
          supplierType: z.enum(['TOUR_OPERATOR', 'TICKET', 'ACTIVITY', 'PACKAGE', 'TRANSPORT', 'CHARTER']),
          businessProfileId: z.uuid().optional(),
        }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`supplier-apply:${actor.userId}`]);
        const existing = await maybeOne(tx, `SELECT id, status FROM suppliers WHERE owner_user_id = $1 AND status IN ('PENDING','APPROVED','SUSPENDED')`, [actor.userId]);
        if (existing) throw conflict('SUPPLIER_EXISTS', `You already have a supplier application (${existing.status})`);
        if (req.body.businessProfileId) {
          const bp = await maybeOne(tx, `SELECT id FROM business_profiles WHERE id = $1 AND user_id = $2`, [req.body.businessProfileId, actor.userId]).catch(() => null);
          if (!bp) throw badRequest('INVALID_BUSINESS_PROFILE', 'Business profile not found');
        }
        const s = await one(tx, `INSERT INTO suppliers(owner_user_id, name, supplier_type, business_profile_id) VALUES ($1,$2,$3,$4) RETURNING *`, [
          actor.userId,
          req.body.name,
          req.body.supplierType,
          req.body.businessProfileId ?? null,
        ]);
        await recordTransition(tx, ctx, { aggregateType: 'supplier', aggregateId: s.id, from: null, to: 'PENDING', reason: 'APPLIED' });
        await emit(tx, ctx, { aggregateType: 'supplier', aggregateId: s.id, eventType: 'supplier.applied', payload: { supplierId: s.id, ownerUserId: actor.userId } });
        return s;
      });
      return reply.status(201).send({ item: supplierDto(row) });
    },
  );

  r.get('/v1/suppliers/me', { schema: { summary: 'Get the supplier profile of the current user', tags: [T1] }, preHandler: requireAuth }, async (req) => {
    const s = await maybeOne(pool, `SELECT * FROM suppliers WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [getActor(req).userId]);
    if (!s) throw notFound('Supplier');
    return { item: supplierDto(s) };
  });

  r.get(
    '/v1/admin/suppliers',
    { schema: { summary: 'List travel suppliers', tags: [T1], querystring: z.object({ status: z.enum(['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED']).optional() }) }, preHandler: requireRole('ADMIN', 'COMPLIANCE') },
    async (req) => {
      const rows = await q(pool, `SELECT * FROM suppliers WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`, [req.query.status ?? null]);
      return { items: rows.map(supplierDto) };
    },
  );

  r.post(
    '/v1/admin/suppliers/:id/approve',
    {
      schema: {
        tags: [T1],
        summary: 'Approve a supplier; merchant-of-record and commission are set per the G9 approval',
        params: idParams,
        body: z.object({ merchantOfRecord: z.enum(['JETPOOL', 'SUPPLIER']), commissionBps: z.number().int().min(0).max(10000), reason: z.string().max(500).optional() }),
      },
      preHandler: requireRole('ADMIN'),
    },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const before = await maybeOne(tx, `SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!before) throw notFound('Supplier');
        const { row } = await SupplierFSM.transition(tx, ctx, {
          table: 'suppliers',
          id: req.params.id,
          from: ['PENDING', 'SUSPENDED'],
          to: 'APPROVED',
          reason: req.body.reason ?? 'APPROVED',
          set: { merchant_of_record: req.body.merchantOfRecord, commission_bps: req.body.commissionBps, updated_at: new Date() },
        });
        if (before.owner_user_id) await grantRole(tx, ctx, { userId: before.owner_user_id, role: 'SUPPLIER', reason: `supplier ${before.id} approved` });
        await auditSupplierDecision(tx, ctx, before.id, supplierDto(before), supplierDto(row), req.body.reason);
        await audit(tx, ctx, { action: 'supplier.commercial_terms', resourceType: 'supplier', resourceId: before.id, category: 'MONEY', after: { merchantOfRecord: row.merchant_of_record, commissionBps: row.commission_bps } });
        await emit(tx, ctx, { aggregateType: 'supplier', aggregateId: before.id, eventType: 'supplier.approved', payload: { supplierId: before.id } });
        return row;
      });
      return { item: supplierDto(row) };
    },
  );

  r.post(
    '/v1/admin/suppliers/:id/decision',
    { schema: { summary: 'Approve or reject a supplier application', tags: [T1], params: idParams, body: z.object({ decision: z.enum(['REJECTED', 'SUSPENDED']), reason: z.string().min(3).max(500) }) }, preHandler: requireRole('ADMIN') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const before = await maybeOne(tx, `SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!before) throw notFound('Supplier');
        const { row } = await SupplierFSM.transition(tx, ctx, { table: 'suppliers', id: req.params.id, to: req.body.decision, reason: req.body.reason, set: { updated_at: new Date() } });
        if (req.body.decision === 'SUSPENDED') {
          await tx.query(`UPDATE travel_products SET status = 'PAUSED' WHERE supplier_id = $1 AND status = 'PUBLISHED'`, [req.params.id]);
        }
        await auditSupplierDecision(tx, ctx, before.id, supplierDto(before), supplierDto(row), req.body.reason);
        return row;
      });
      return { item: supplierDto(row) };
    },
  );

  // ------------------------------------------------------------------ TRAVEL-01 supplier extranet
  const supplierOnly = requireRole('SUPPLIER');

  r.get('/v1/supplier/products', { schema: { summary: 'List the travel products of the supplier', tags: [T1], querystring: z.object({ status: z.string().optional() }) }, preHandler: supplierOnly }, async (req) => {
    const s = await supplierOf(pool, getActor(req).userId, { allowPending: true });
    const rows = await q(pool, `SELECT * FROM travel_products WHERE supplier_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 500`, [s.id, req.query.status ?? null]);
    return { items: rows.map((p) => productDto(p)) };
  });

  r.post('/v1/supplier/products', { schema: { summary: 'Create a travel product draft', tags: [T1], body: z.object(productBase) }, preHandler: supplierOnly }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const b = req.body;
    const id = await withTx(pool, async (tx) => {
      const s = await supplierOf(tx, getActor(req).userId);
      const p = await one(
        tx,
        `INSERT INTO travel_products(supplier_id, type, title, summary, description, city, country, duration_minutes, base_price_minor, currency, cancellation_terms, media_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [s.id, b.type, b.title, b.summary ?? null, b.description ?? null, b.city ?? null, b.country ?? 'KR', b.durationMinutes ?? null, b.basePriceMinor ?? null, b.currency ?? 'KRW', JSON.stringify(b.cancellationTerms ?? {}), b.mediaIds ?? []],
      );
      if (b.options?.length) await upsertOptions(tx, p.id, b.options);
      await recordTransition(tx, ctx, { aggregateType: 'travel_product', aggregateId: p.id, from: null, to: 'DRAFT', reason: 'CREATED' });
      return p.id as string;
    });
    const out = await productWithOptions(pool, id);
    return reply.status(201).send({ item: productDto(out!.row, { options: out!.options }) });
  });

  r.patch(
    '/v1/supplier/products/:id',
    { schema: { summary: 'Update a travel product', tags: [T1], params: idParams, body: z.object(productBase).partial().omit({ type: true }) }, preHandler: supplierOnly },
    async (req) => {
      const b = req.body;
      const ctx = ctxFromRequest(req);
      await withTx(pool, async (tx) => {
        const s = await supplierOf(tx, getActor(req).userId, { allowPending: true });
        const p = await maybeOne(tx, `SELECT * FROM travel_products WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!p || p.supplier_id !== s.id) throw notFound('Product');
        if (p.status === 'ARCHIVED') throw conflict('PRODUCT_ARCHIVED', 'Archived products cannot be edited');
        const before = await productContent(tx, p.id);
        const map: Record<string, [string, unknown]> = {
          title: ['title', b.title],
          summary: ['summary', b.summary],
          description: ['description', b.description],
          city: ['city', b.city],
          country: ['country', b.country],
          durationMinutes: ['duration_minutes', b.durationMinutes],
          basePriceMinor: ['base_price_minor', b.basePriceMinor],
          currency: ['currency', b.currency],
          cancellationTerms: ['cancellation_terms', b.cancellationTerms === undefined ? undefined : JSON.stringify(b.cancellationTerms)],
          mediaIds: ['media_ids', b.mediaIds],
        };
        const sets: string[] = [];
        const params: unknown[] = [p.id];
        for (const [k, [col, val]] of Object.entries(map)) {
          if ((b as any)[k] === undefined) continue;
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
        if (sets.length) await tx.query(`UPDATE travel_products SET ${sets.join(', ')} WHERE id = $1`, params);
        if (b.options) await upsertOptions(tx, p.id, b.options);
        // TRAVEL-01 review workflow: every field here is buyer-facing. Content that changed after a review (PUBLISHED /
        // PAUSED) goes back to IN_REVIEW in the same tx — it leaves the public catalog until an editor re-approves it.
        // Content changed while IN_REVIEW is withdrawn to DRAFT, so an editor can never publish a version they did not
        // see in the queue; the supplier resubmits it.
        if ((await productContent(tx, p.id)) !== before) {
          const to = p.status === 'PUBLISHED' || p.status === 'PAUSED' ? 'IN_REVIEW' : p.status === 'IN_REVIEW' ? 'DRAFT' : null;
          if (to) {
            const reason = to === 'IN_REVIEW' ? 'EDITED_AFTER_REVIEW' : 'EDITED_DURING_REVIEW';
            await ProductFSM.transition(tx, ctx, { table: 'travel_products', id: p.id, from: p.status, to, reason });
            await audit(tx, ctx, { action: 'travel_product.edited', resourceType: 'travel_product', resourceId: p.id, category: 'CONTENT', reason, before: { status: p.status }, after: { status: to } });
            await emit(tx, ctx, { aggregateType: 'travel_product', aggregateId: p.id, eventType: 'travel.product.review_required', payload: { productId: p.id, supplierId: p.supplier_id, from: p.status, to } });
          }
        }
      });
      const out = await productWithOptions(pool, req.params.id);
      return { item: productDto(out!.row, { options: out!.options }) };
    },
  );

  r.post('/v1/supplier/products/:id/submit', { schema: { summary: 'Submit a travel product for review', tags: [T1], params: idParams }, preHandler: supplierOnly }, async (req) => {
    const ctx = ctxFromRequest(req);
    const row = await withTx(pool, async (tx) => {
      const s = await supplierOf(tx, getActor(req).userId);
      const p = await maybeOne(tx, `SELECT supplier_id FROM travel_products WHERE id = $1`, [req.params.id]);
      if (!p || p.supplier_id !== s.id) throw notFound('Product');
      return (await ProductFSM.transition(tx, ctx, { table: 'travel_products', id: req.params.id, from: ['DRAFT', 'PAUSED', 'PUBLISHED'], to: 'IN_REVIEW', reason: 'SUBMITTED' })).row;
    });
    return { item: productDto(row) };
  });

  // ------------------------------------------------------------------ TRAVEL-01 admin review
  r.get(
    '/v1/admin/travel-products',
    { schema: { summary: 'List travel products', tags: [T1], querystring: z.object({ status: z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'PAUSED', 'ARCHIVED']).optional() }) }, preHandler: requireRole('ADMIN', 'EDITOR', 'COMPLIANCE') },
    async (req) => {
      const rows = await q(
        pool,
        `SELECT p.*, s.name AS supplier_name, s.merchant_of_record FROM travel_products p JOIN suppliers s ON s.id = p.supplier_id
          WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.updated_at DESC LIMIT 500`,
        [req.query.status ?? null],
      );
      return { items: rows.map((p) => productDto(p)) };
    },
  );

  r.post(
    '/v1/admin/travel-products/:id/publish',
    { schema: { summary: 'Publish a travel product', tags: [T1], params: idParams, body: z.object({ note: z.string().max(1000).optional() }).optional() }, preHandler: requireRole('ADMIN', 'EDITOR') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const p = await maybeOne(tx, `SELECT p.*, s.status AS supplier_status FROM travel_products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1 FOR UPDATE OF p`, [req.params.id]);
        if (!p) throw notFound('Product');
        if (p.supplier_status !== 'APPROVED') throw conflict('SUPPLIER_NOT_APPROVED', 'The supplier must be approved before publishing');
        if (p.base_price_minor == null) {
          const priced = await maybeOne(tx, `SELECT 1 FROM travel_departures WHERE product_id = $1 AND price_minor IS NOT NULL LIMIT 1`, [p.id]);
          if (!priced) throw conflict('PRICE_REQUIRED', 'A base price or priced departure is required');
        }
        const slug = p.slug ?? `${String(p.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tour'}-${p.id.slice(0, 8)}`;
        const { row } = await ProductFSM.transition(tx, ctx, { table: 'travel_products', id: p.id, from: ['IN_REVIEW', 'PAUSED'], to: 'PUBLISHED', reason: req.body?.note ?? 'REVIEWED', set: { slug } });
        await audit(tx, ctx, { action: 'travel_product.publish', resourceType: 'travel_product', resourceId: p.id, category: 'CONTENT', reason: req.body?.note ?? null });
        await emit(tx, ctx, { aggregateType: 'travel_product', aggregateId: p.id, eventType: 'travel.product.published', payload: { productId: p.id, supplierId: p.supplier_id } });
        return row;
      });
      return { item: productDto(row) };
    },
  );

  r.post(
    '/v1/admin/travel-products/:id/reject',
    { schema: { summary: 'Reject a travel product', tags: [T1], params: idParams, body: z.object({ reason: z.string().min(3).max(1000), to: z.enum(['DRAFT', 'PAUSED', 'ARCHIVED']).default('DRAFT') }) }, preHandler: requireRole('ADMIN', 'EDITOR') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const { row } = await ProductFSM.transition(tx, ctx, { table: 'travel_products', id: req.params.id, to: req.body.to, reason: req.body.reason });
        await audit(tx, ctx, { action: 'travel_product.reject', resourceType: 'travel_product', resourceId: req.params.id, category: 'CONTENT', reason: req.body.reason });
        return row;
      });
      return { item: productDto(row) };
    },
  );

  // ------------------------------------------------------------------ TRAVEL-01 public catalog
  r.get(
    '/v1/travel-products',
    {
      schema: { summary: 'Browse published travel products',
        tags: [T1],
        querystring: pagination.extend({
          type: productType.optional(),
          city: z.string().max(100).optional(),
          country: z.string().regex(/^[A-Z]{2}$/).optional(),
          q: z.string().max(100).optional(),
          minPrice: z.coerce.number().int().nonnegative().optional(),
          maxPrice: z.coerce.number().int().nonnegative().optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
        }),
      },
    },
    async (req) => {
      const f = req.query;
      const c = decodeCursor(f.cursor);
      const rows = await q(
        pool,
        `SELECT p.*, s.name AS supplier_name, s.merchant_of_record, ${cursorColumns('p')},
                (SELECT min(coalesce(d.price_minor, p.base_price_minor)) FROM travel_departures d
                  WHERE d.product_id = p.id AND d.status IN ('OPEN','GUARANTEED') AND d.starts_at > now()) AS from_price_minor
           FROM travel_products p JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.status = 'PUBLISHED' AND s.status = 'APPROVED'
            AND ($1::text IS NULL OR p.type = $1)
            AND ($2::text IS NULL OR p.city ILIKE $2)
            AND ($3::text IS NULL OR p.country = $3)
            AND ($4::text IS NULL OR p.title ILIKE '%' || $4 || '%' OR p.summary ILIKE '%' || $4 || '%')
            AND ($5::bigint IS NULL OR p.base_price_minor >= $5)
            AND ($6::bigint IS NULL OR p.base_price_minor <= $6)
            AND (($7::date IS NULL AND $8::date IS NULL) OR EXISTS (
                  SELECT 1 FROM travel_departures d WHERE d.product_id = p.id AND d.status IN ('OPEN','GUARANTEED')
                     AND ($7::date IS NULL OR d.starts_at >= $7::date) AND ($8::date IS NULL OR d.starts_at < $8::date + 1)))
            AND ($9::timestamptz IS NULL OR (p.created_at, p.id) < ($9::timestamptz, $10::uuid))
          ORDER BY p.created_at DESC, p.id DESC LIMIT $11`,
        [
          f.type ?? null,
          f.city ?? null,
          f.country ?? null,
          f.q ? f.q.replace(/[%_\\]/g, (m) => `\\${m}`) : null,
          f.minPrice ?? null,
          f.maxPrice ?? null,
          f.from ?? null,
          f.to ?? null,
          c?.createdAt ?? null,
          c?.id ?? null,
          f.limit + 1,
        ],
      );
      const pg = page(rows, f.limit);
      return { items: pg.items.map((p: any) => productDto(p, { fromPriceMinor: p.from_price_minor ?? p.base_price_minor })), nextCursor: pg.nextCursor };
    },
  );

  r.get('/v1/travel-products/:id', { schema: { summary: 'Get a published travel product', tags: [T1], params: idParams } }, async (req) => {
    const out = await productWithOptions(pool, req.params.id);
    if (!out) throw notFound('Product');
    const actor = req.actor;
    const visible =
      (out.row.status === 'PUBLISHED' && out.row.supplier_status === 'APPROVED') ||
      (actor && (out.row.owner_user_id === actor.userId || (hasRole(actor, 'ADMIN', 'EDITOR', 'COMPLIANCE') && actor.aal === 'aal2')));
    if (!visible) throw notFound('Product');
    const deps = await q(pool, `SELECT * FROM travel_departures WHERE product_id = $1 AND starts_at > now() AND status IN ('OPEN','GUARANTEED') ORDER BY starts_at LIMIT 50`, [out.row.id]);
    return { item: productDto(out.row, { options: out.options.filter((o) => o.active), departures: deps.map(departureDto) }) };
  });

  // ------------------------------------------------------------------ TRAVEL-02 departures
  r.get(
    '/v1/travel-products/:id/departures',
    { schema: { summary: 'List the departures of a travel product', tags: [T2], params: idParams, querystring: z.object({ from: isoDate.optional(), to: isoDate.optional(), includePast: z.enum(['true', 'false']).default('false') }) } },
    async (req) => {
      const p = await maybeOne(pool, `SELECT p.status, s.status AS supplier_status, s.owner_user_id FROM travel_products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [req.params.id]);
      if (!p) throw notFound('Product');
      const owner = !!req.actor && p.owner_user_id === req.actor.userId;
      if (!owner && !(p.status === 'PUBLISHED' && p.supplier_status === 'APPROVED')) throw notFound('Product');
      const rows = await q(
        pool,
        `SELECT * FROM travel_departures WHERE product_id = $1
            AND ($2::date IS NULL OR starts_at >= $2::date) AND ($3::date IS NULL OR starts_at < $3::date + 1)
            AND ($4::boolean OR (starts_at > now() AND status IN ('OPEN','GUARANTEED')))
          ORDER BY starts_at LIMIT 500`,
        [req.params.id, req.query.from ?? null, req.query.to ?? null, owner && req.query.includePast === 'true'],
      );
      return { items: rows.map(departureDto) };
    },
  );

  r.post(
    '/v1/travel-products/:id/departures',
    {
      schema: { summary: 'Create a departure for a travel product',
        tags: [T2],
        params: idParams,
        body: z
          .object({
            startsAt: datetime,
            endsAt: datetime.optional(),
            capacity: z.number().int().min(1).max(100000),
            minParticipants: z.number().int().min(1).max(100000).default(1),
            priceMinor: minorSchema.optional(),
            cutoffAt: datetime.optional(),
          })
          .refine((d) => d.minParticipants <= d.capacity, { message: 'minParticipants must not exceed capacity', path: ['minParticipants'] })
          .refine((d) => !d.endsAt || new Date(d.endsAt) > new Date(d.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] })
          .refine((d) => !d.cutoffAt || new Date(d.cutoffAt) <= new Date(d.startsAt), { message: 'cutoffAt must be before startsAt', path: ['cutoffAt'] }),
      },
      preHandler: supplierOnly,
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const b = req.body;
      if (new Date(b.startsAt).getTime() <= Date.now()) throw badRequest('DEPARTURE_IN_PAST', 'startsAt must be in the future');
      const row = await withTx(pool, async (tx) => {
        const s = await supplierOf(tx, getActor(req).userId);
        const p = await maybeOne(tx, `SELECT supplier_id, status FROM travel_products WHERE id = $1`, [req.params.id]);
        if (!p || p.supplier_id !== s.id) throw notFound('Product');
        if (p.status === 'ARCHIVED') throw conflict('PRODUCT_ARCHIVED', 'Archived product');
        const d = await one(
          tx,
          `INSERT INTO travel_departures(product_id, starts_at, ends_at, capacity, min_participants, price_minor, cutoff_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [req.params.id, b.startsAt, b.endsAt ?? null, b.capacity, b.minParticipants, b.priceMinor ?? null, b.cutoffAt ?? null],
        );
        await recordTransition(tx, ctx, { aggregateType: 'travel_departure', aggregateId: d.id, from: null, to: 'OPEN', reason: 'CREATED' });
        await emit(tx, ctx, { aggregateType: 'travel_departure', aggregateId: d.id, eventType: 'travel.inventory.changed', payload: { departureId: d.id, capacity: d.capacity } });
        return d;
      });
      return reply.status(201).send({ item: departureDto(row) });
    },
  );

  r.patch(
    '/v1/supplier/departures/:id',
    { schema: { summary: 'Update a departure', tags: [T2], params: idParams, body: z.object({ capacity: z.number().int().min(0).max(100000).optional(), status: z.enum(['OPEN', 'CLOSED']).optional() }) }, preHandler: supplierOnly },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const s = await supplierOf(tx, getActor(req).userId);
        const d = await maybeOne(tx, `SELECT d.*, p.supplier_id FROM travel_departures d JOIN travel_products p ON p.id = d.product_id WHERE d.id = $1 FOR UPDATE OF d`, [req.params.id]);
        if (!d || d.supplier_id !== s.id) throw notFound('Departure');
        if (req.body.capacity !== undefined) {
          const u = await tx.query(`UPDATE travel_departures SET capacity = $2 WHERE id = $1 AND booked <= $2`, [d.id, req.body.capacity]);
          if (u.rowCount === 0) throw conflict('CAPACITY_BELOW_BOOKED', 'Capacity cannot be lower than seats already booked');
        }
        if (req.body.status && req.body.status !== d.status) await DepartureFSM.transition(tx, ctx, { table: 'travel_departures', id: d.id, to: req.body.status, reason: 'SUPPLIER' });
        await emit(tx, ctx, { aggregateType: 'travel_departure', aggregateId: d.id, eventType: 'travel.inventory.changed', payload: { departureId: d.id, ...req.body } });
        return maybeOne(tx, `SELECT * FROM travel_departures WHERE id = $1`, [d.id]);
      });
      return { item: departureDto(row) };
    },
  );

  r.post(
    '/v1/supplier/departures/:id/cancel',
    { schema: { summary: 'Cancel a departure', tags: [T2], params: idParams, body: z.object({ reason: z.string().min(3).max(500) }) }, preHandler: supplierOnly },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const n = await withTx(pool, async (tx) => {
        const s = await supplierOf(tx, getActor(req).userId);
        const d = await maybeOne(tx, `SELECT d.id, p.supplier_id FROM travel_departures d JOIN travel_products p ON p.id = d.product_id WHERE d.id = $1 FOR UPDATE OF d`, [req.params.id]);
        if (!d || d.supplier_id !== s.id) throw notFound('Departure');
        return cancelDeparture(tx, ctx, d.id, `SUPPLIER_CANCELLED: ${req.body.reason}`);
      });
      const d = await maybeOne(pool, `SELECT * FROM travel_departures WHERE id = $1`, [req.params.id]);
      return { item: departureDto(d), cancelledOrders: n };
    },
  );

  // ------------------------------------------------------------------ TRAVEL-03 itineraries
  const itineraryBody = z.object({
    title: z.string().trim().min(1).max(200),
    startDate: isoDate.optional().nullable(),
    endDate: isoDate.optional().nullable(),
    visibility: z.enum(['PRIVATE', 'SHARED']).default('PRIVATE'),
  });

  async function itineraryFor(db: any, id: string, userId: string, write: boolean) {
    const it = await maybeOne(db, `SELECT * FROM itineraries WHERE id = $1 ${write ? 'FOR UPDATE' : ''}`, [id]);
    if (!it) throw notFound('Itinerary');
    if (it.owner_id !== userId && (write || it.visibility !== 'SHARED')) throw notFound('Itinerary');
    return it;
  }
  async function itineraryOut(db: any, id: string) {
    const it = await maybeOne(db, `SELECT * FROM itineraries WHERE id = $1`, [id]);
    const items = await q(db, `SELECT * FROM itinerary_items WHERE itinerary_id = $1 ORDER BY day_index, sort_order, id`, [id]);
    return {
      id: it.id,
      ownerId: it.owner_id,
      title: it.title,
      startDate: it.start_date,
      endDate: it.end_date,
      visibility: it.visibility,
      version: it.version,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
      items: items.map(itemDto),
    };
  }
  async function touchItinerary(tx: any, ctx: any, id: string, change: string) {
    const row = await one(tx, `UPDATE itineraries SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`, [id]);
    await emit(tx, ctx, { aggregateType: 'itinerary', aggregateId: id, eventType: 'itinerary.updated', payload: { itineraryId: id, version: row.version, change } });
  }

  r.post('/v1/itineraries', { schema: { summary: 'Create an itinerary', tags: [T3], body: itineraryBody.refine((b) => !b.startDate || !b.endDate || b.endDate >= b.startDate, { message: 'endDate must not precede startDate' }) }, preHandler: requireAuth }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const id = await withTx(pool, async (tx) => {
      const it = await one(tx, `INSERT INTO itineraries(owner_id, title, start_date, end_date, visibility) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        getActor(req).userId,
        req.body.title,
        req.body.startDate ?? null,
        req.body.endDate ?? null,
        req.body.visibility,
      ]);
      await emit(tx, ctx, { aggregateType: 'itinerary', aggregateId: it.id, eventType: 'itinerary.updated', payload: { itineraryId: it.id, version: 1, change: 'CREATED' } });
      return it.id as string;
    });
    return reply.status(201).send({ item: await itineraryOut(pool, id) });
  });

  r.get('/v1/itineraries', { schema: { summary: 'List itineraries', tags: [T3] }, preHandler: requireAuth }, async (req) => {
    const rows = await q(pool, `SELECT id FROM itineraries WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 100`, [getActor(req).userId]);
    return { items: await Promise.all(rows.map((r0: any) => itineraryOut(pool, r0.id))) };
  });

  r.get('/v1/itineraries/:id', { schema: { summary: 'Get an itinerary with its days and activities', tags: [T3], params: idParams }, preHandler: requireAuth }, async (req) => {
    await itineraryFor(pool, req.params.id, getActor(req).userId, false);
    return { item: await itineraryOut(pool, req.params.id) };
  });

  r.patch('/v1/itineraries/:id', { schema: { summary: 'Update an itinerary', tags: [T3], params: idParams, body: itineraryBody.partial().extend({ version: z.number().int().positive().optional() }) }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    await withTx(pool, async (tx) => {
      const it = await itineraryFor(tx, req.params.id, getActor(req).userId, true);
      if (req.body.version !== undefined && req.body.version !== it.version) throw conflict('STALE_VERSION', 'The itinerary was changed by someone else; reload it');
      const start = req.body.startDate !== undefined ? req.body.startDate : it.start_date;
      const end = req.body.endDate !== undefined ? req.body.endDate : it.end_date;
      if (start && end && end < start) throw badRequest('INVALID_DATES', 'endDate must not precede startDate');
      await tx.query(`UPDATE itineraries SET title = $2, start_date = $3, end_date = $4, visibility = $5 WHERE id = $1`, [it.id, req.body.title ?? it.title, start, end, req.body.visibility ?? it.visibility]);
      await touchItinerary(tx, ctx, it.id, 'UPDATED');
    });
    return { item: await itineraryOut(pool, req.params.id) };
  });

  r.post(
    '/v1/itineraries/:id/items',
    {
      schema: { summary: 'Add an activity to an itinerary',
        tags: [T3],
        params: idParams,
        body: z.object({
          dayIndex: z.number().int().min(0).max(365),
          sortOrder: z.number().int().min(0).max(10000).optional(),
          itemType: z.enum(['STAY', 'EXCHANGE', 'GUIDE', 'TRAVEL_PRODUCT', 'NOTE', 'TRANSPORT']),
          refId: z.uuid().optional().nullable(),
          title: z.string().trim().min(1).max(200),
          // HH:MM[:SS] within a day ('25:00' / '99:99' would reach the time column and fail with 22008)
          startTime: z.string().regex(TIME_OF_DAY, 'HH:MM or HH:MM:SS (00:00–23:59)').optional().nullable(),
          endTime: z.string().regex(TIME_OF_DAY, 'HH:MM or HH:MM:SS (00:00–23:59)').optional().nullable(),
          note: z.string().max(4000).optional().nullable(),
        }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const b = req.body;
      await withTx(pool, async (tx) => {
        const it = await itineraryFor(tx, req.params.id, getActor(req).userId, true);
        const table = ITEM_REF_TABLE[b.itemType];
        if (table) {
          if (!b.refId) throw badRequest('REF_REQUIRED', `${b.itemType} items must reference a ${table} record`);
          // read-only existence check against the owning domain's table
          const extra = b.itemType === 'TRAVEL_PRODUCT' ? ` AND status = 'PUBLISHED'` : '';
          const col = table === 'guide_profiles' ? 'user_id' : 'id';
          const ok = await maybeOne(tx, `SELECT 1 FROM ${table} WHERE ${col} = $1${extra}`, [b.refId]);
          if (!ok) throw badRequest('REF_NOT_FOUND', `Referenced ${b.itemType.toLowerCase()} not found`);
        }
        const so = b.sortOrder ?? (await one<{ n: number }>(tx, `SELECT coalesce(max(sort_order) + 1, 0)::int AS n FROM itinerary_items WHERE itinerary_id = $1 AND day_index = $2`, [it.id, b.dayIndex])).n;
        await tx.query(
          `INSERT INTO itinerary_items(itinerary_id, day_index, sort_order, item_type, ref_id, title, start_time, end_time, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [it.id, b.dayIndex, so, b.itemType, b.refId ?? null, b.title, b.startTime ?? null, b.endTime ?? null, b.note ?? null],
        );
        await touchItinerary(tx, ctx, it.id, 'ITEM_ADDED');
      });
      return reply.status(201).send({ item: await itineraryOut(pool, req.params.id) });
    },
  );

  r.post(
    '/v1/itineraries/:id/items/reorder',
    {
      schema: { summary: 'Reorder the activities of an itinerary', tags: [T3], params: idParams, body: z.object({ items: z.array(z.object({ id: z.uuid(), dayIndex: z.number().int().min(0).max(365), sortOrder: z.number().int().min(0).max(10000) })).min(1).max(500) }) },
      preHandler: requireAuth,
    },
    async (req) => {
      const ctx = ctxFromRequest(req);
      await withTx(pool, async (tx) => {
        const it = await itineraryFor(tx, req.params.id, getActor(req).userId, true);
        for (const i of req.body.items) {
          const u = await tx.query(`UPDATE itinerary_items SET day_index = $3, sort_order = $4 WHERE id = $1 AND itinerary_id = $2`, [i.id, it.id, i.dayIndex, i.sortOrder]);
          if (u.rowCount === 0) throw badRequest('ITEM_NOT_FOUND', `Item ${i.id} is not part of this itinerary`);
        }
        await touchItinerary(tx, ctx, it.id, 'REORDERED');
      });
      return { item: await itineraryOut(pool, req.params.id) };
    },
  );

  r.delete('/v1/itineraries/:id/items/:itemId', { schema: { summary: 'Remove an activity from an itinerary', tags: [T3], params: z.object({ id: z.uuid(), itemId: z.uuid() }) }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    await withTx(pool, async (tx) => {
      const it = await itineraryFor(tx, req.params.id, getActor(req).userId, true);
      const d = await tx.query(`DELETE FROM itinerary_items WHERE id = $1 AND itinerary_id = $2`, [req.params.itemId, it.id]);
      if (d.rowCount === 0) throw notFound('Itinerary item');
      await touchItinerary(tx, ctx, it.id, 'ITEM_REMOVED');
    });
    return { item: await itineraryOut(pool, req.params.id) };
  });

  // ------------------------------------------------------------------ TRAVEL-04 orders
  r.post(
    '/v1/orders',
    {
      schema: {
        tags: [T4],
        summary: 'Create an order; totals are computed server-side and seats are reserved atomically',
        body: z.object({ items: z.array(z.object({ departureId: z.uuid(), qty: z.number().int().min(1).max(50), optionIds: z.array(z.uuid()).max(20).optional() })).min(1).max(20) }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      await assertEnabled(pool, 'travel.commerce', { userId: actor.userId, roles: actor.roles });
      const key = idempotencyKeyFrom(req);
      const res = await withIdempotency(pool, `orders.create:${actor.userId}`, key, req.body, async (tx) => ({ status: 201, body: { item: await createOrder(tx, ctx, req.body) } }));
      return reply.status(res.status).header('idempotent-replayed', String(res.replayed)).send(res.body);
    },
  );

  r.get('/v1/orders', { schema: { summary: 'List orders of the current user', tags: [T4], querystring: pagination.extend({ status: z.string().optional() }) }, preHandler: requireAuth }, async (req) => {
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT *, ${cursorColumns()} FROM orders WHERE buyer_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [getActor(req).userId, req.query.status ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    const pg = page(rows, req.query.limit);
    return { items: pg.items.map((o: any) => orderDto(o)), nextCursor: pg.nextCursor };
  });

  r.get('/v1/orders/:id', { schema: { summary: 'Get an order', tags: [T4], params: idParams }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const out = await loadOrder(pool, req.params.id);
    if (!out) throw notFound('Order');
    const staff = hasRole(actor, 'ADMIN', 'SUPPORT', 'ACCOUNTING') && actor.aal === 'aal2';
    if (out.order.buyer_id === actor.userId || staff) return { item: out.dto };
    // a supplier of (one of) the order's lines sees only its own lines, vouchers and pricing entry — never another
    // supplier's products, prices, terms or the buyer's bearer voucher codes for them (same scope as /v1/supplier/orders)
    const own = await q<{ supplier_id: string }>(
      pool,
      `SELECT DISTINCT i.supplier_id FROM order_items i JOIN suppliers s ON s.id = i.supplier_id WHERE i.order_id = $1 AND s.owner_user_id = $2`,
      [req.params.id, actor.userId],
    );
    if (!own.length) throw notFound('Order');
    return { item: await supplierOrderView(pool, out.order, out.items, out.vouchers, own.map((r) => r.supplier_id)) };
  });

  r.post(
    '/v1/orders/:id/cancel',
    { schema: { summary: 'Cancel an order', tags: [T4], params: idParams, body: z.object({ reason: z.string().trim().min(2).max(300).default('BUYER_REQUEST') }) }, preHandler: requireAuth },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req);
      const staff = hasRole(actor, 'ADMIN', 'SUPPORT') && actor.aal === 'aal2';
      // scope per actor (like booking/guide cancel): a replay returns the stored response WITHOUT re-running fn, so an
      // order-scoped record would hand the buyer's cancellation to anyone presenting the same key, skipping requireBuyer
      const res = await withIdempotency(pool, `orders.cancel:${actor.userId}`, key, { id: req.params.id, ...req.body }, async (tx) => {
        const out = await cancelOrder(tx, ctx, { orderId: req.params.id, reason: req.body.reason, requireBuyer: staff ? null : actor.userId });
        if (staff) await audit(tx, ctx, { action: 'order.cancel.staff', resourceType: 'order', resourceId: req.params.id, category: 'MONEY', reason: req.body.reason });
        return { body: { item: out.order, refund: out.refund } };
      });
      return reply.status(res.status).send(res.body);
    },
  );

  r.get('/v1/supplier/orders', { schema: { summary: 'List orders for the products of the supplier', tags: [T4], querystring: pagination.extend({ status: z.string().optional() }) }, preHandler: supplierOnly }, async (req) => {
    const s = await supplierOf(pool, getActor(req).userId, { allowPending: true });
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT o.*, ${cursorColumns('o')} FROM orders o
        WHERE EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.supplier_id = $1)
          AND o.status NOT IN ('CART') AND ($2::text IS NULL OR o.status = $2)
          AND ($3::timestamptz IS NULL OR (o.created_at, o.id) < ($3::timestamptz, $4::uuid))
        ORDER BY o.created_at DESC, o.id DESC LIMIT $5`,
      [s.id, req.query.status ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    const pg = page(rows, req.query.limit);
    const ids = pg.items.map((o: any) => o.id);
    const items = ids.length ? await q(pool, `SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) AND supplier_id = $2`, [ids, s.id]) : [];
    const termKeys = [...new Set(pg.items.flatMap((o: any) => Object.keys(o.pricing_snapshot?.cancellationTerms ?? {})))].filter((k) => /^[0-9a-f-]{36}$/i.test(k));
    const ownProducts = termKeys.length
      ? (await q<{ id: string }>(pool, `SELECT id FROM travel_products WHERE id = ANY($1::uuid[]) AND supplier_id = $2`, [termKeys, s.id])).map((p) => p.id)
      : [];
    return {
      // buyer identity limited to id; supplier sees only its own lines, its own pricing.suppliers[] entry and its own
      // products' cancellation terms
      items: pg.items.map((o: any) => orderDto(o, items.filter((i: any) => i.order_id === o.id), [], { supplierId: s.id, productIds: ownProducts })),
      nextCursor: pg.nextCursor,
    };
  });

  registerJob('travel.orders.expire', 60_000, (appCtx) => expireOrders(appCtx, systemCtx(appCtx, `job-orders-expire-${Date.now()}`)));
  registerJob('travel.departures.lifecycle', 5 * 60_000, (appCtx) => runDepartureLifecycle(appCtx, systemCtx(appCtx, `job-departures-${Date.now()}`)));

}
