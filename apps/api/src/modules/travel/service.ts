/**
 * TRAVEL-01..04 domain logic: suppliers, products, departures (capacity), orders (+ ORDER payment subject).
 * Capacity is reserved atomically with a conditional UPDATE (no overbooking under concurrency, TRAVEL-02).
 * Totals are always computed server-side (TRAVEL-04); fees come from approved finance rules (FIN-03).
 */
import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { StateMachine, recordTransition } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { allocate, applyBps } from '../../platform/money.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { registerPaymentSubject, type PayableSnapshot } from '../../platform/payment-subjects.js';
import { quoteFees } from '../finance/rules.js';
import { refundableRemaining, requestRefund } from '../payments/service.js';

export type OrderStatus = 'CART' | 'PENDING' | 'PAYMENT_PENDING' | 'PAID' | 'FULFILLED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'PAYMENT_FAILED' | 'EXPIRED';
export type DepartureStatus = 'OPEN' | 'CLOSED' | 'GUARANTEED' | 'CANCELLED' | 'DEPARTED';
export type ProductStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'PAUSED' | 'ARCHIVED';
export type SupplierStatus = 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REJECTED';

export const OrderFSM = new StateMachine<OrderStatus>('order', {
  CART: ['PENDING', 'CANCELLED'],
  PENDING: ['PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'],
  PAYMENT_PENDING: ['PAID', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED', 'PAYMENT_PENDING'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'PAID', 'CANCELLED', 'EXPIRED'],
  PAID: ['FULFILLED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'FULFILLED', 'CANCELLED'],
  FULFILLED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
  EXPIRED: [],
});

export const DepartureFSM = new StateMachine<DepartureStatus>('travel_departure', {
  OPEN: ['GUARANTEED', 'CLOSED', 'CANCELLED', 'DEPARTED'],
  GUARANTEED: ['CLOSED', 'CANCELLED', 'DEPARTED'],
  CLOSED: ['OPEN', 'CANCELLED', 'DEPARTED'],
  CANCELLED: [],
  DEPARTED: [],
});

export const ProductFSM = new StateMachine<ProductStatus>('travel_product', {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['PUBLISHED', 'DRAFT', 'ARCHIVED'],
  PUBLISHED: ['PAUSED', 'ARCHIVED', 'IN_REVIEW'],
  PAUSED: ['PUBLISHED', 'IN_REVIEW', 'ARCHIVED'],
  ARCHIVED: [],
});

export const SupplierFSM = new StateMachine<SupplierStatus>('supplier', {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED'],
  SUSPENDED: ['APPROVED'],
  REJECTED: [],
});

const UNPAID: OrderStatus[] = ['PENDING', 'PAYMENT_PENDING', 'PAYMENT_FAILED'];

export const voucherCode = () => `TV${randomBytes(8).toString('hex').toUpperCase().slice(0, 12)}`;

/**
 * Buyer-safe view of pricing_snapshot. The snapshot's suppliers[] (payeeId = supplier owner's user id, gross,
 * commissionBps/commissionMinor) is internal settlement data for payable(); it is never shown to buyers, and a
 * supplier view (opts.supplierId) sees only its own entry.
 */
export interface OrderViewOpts {
  /** supplier view: only these suppliers' pricing.suppliers[] entries */
  supplierId?: string;
  supplierIds?: string[];
  /** supplier view: only these products' snapshotted cancellation terms */
  productIds?: string[];
}

export function pricingDto(p: any, opts: OrderViewOpts = {}) {
  if (!p) return null;
  const sup = new Set([...(opts.supplierIds ?? []), ...(opts.supplierId ? [opts.supplierId] : [])]);
  const supplierView = sup.size > 0;
  const terms =
    supplierView && opts.productIds && p.cancellationTerms && typeof p.cancellationTerms === 'object'
      ? Object.fromEntries(Object.entries(p.cancellationTerms).filter(([productId]) => opts.productIds!.includes(productId)))
      : p.cancellationTerms;
  return {
    subtotalMinor: p.subtotalMinor,
    platformFeeMinor: p.platformFeeMinor,
    taxMinor: p.taxMinor,
    totalMinor: p.totalMinor,
    rulesVersion: p.rulesVersion,
    cancellationTerms: terms,
    quotedAt: p.quotedAt,
    ...(supplierView ? { suppliers: (p.suppliers ?? []).filter((s: any) => sup.has(s.supplierId)) } : {}),
  };
}

/**
 * The order as seen by the owner of one (or more) of its suppliers: only that supplier's lines, its vouchers (never
 * another supplier's bearer codes), its own pricing.suppliers[] entry and its own products' cancellation terms.
 * `vouchers` = null → no voucher codes at all (list view).
 */
export async function supplierOrderView(db: Db, order: any, items: any[], vouchers: any[] | null, supplierIds: string[]) {
  const own = items.filter((i) => supplierIds.includes(i.supplier_id));
  const ownIds = new Set(own.map((i) => i.id));
  const termKeys = Object.keys(order.pricing_snapshot?.cancellationTerms ?? {}).filter((k) => /^[0-9a-f-]{36}$/i.test(k));
  const products = termKeys.length
    ? await q<{ id: string }>(db, `SELECT id FROM travel_products WHERE id = ANY($1::uuid[]) AND supplier_id = ANY($2::uuid[])`, [termKeys, supplierIds])
    : [];
  return orderDto(order, own, (vouchers ?? []).filter((v) => ownIds.has(v.order_item_id)), { supplierIds, productIds: products.map((p) => p.id) });
}

export function orderDto(o: any, items: any[] = [], vouchers: any[] = [], opts: OrderViewOpts = {}) {
  return {
    id: o.id,
    code: o.code,
    buyerId: o.buyer_id,
    status: o.status,
    currency: o.currency,
    subtotalMinor: o.subtotal_minor,
    feeMinor: o.fee_minor,
    totalMinor: o.total_minor,
    refundedMinor: o.refunded_minor,
    merchantOfRecord: o.merchant_of_record,
    pricing: pricingDto(o.pricing_snapshot, opts),
    expiresAt: o.expires_at,
    fulfilledAt: o.fulfilled_at,
    cancelledAt: o.cancelled_at,
    createdAt: o.created_at,
    items: items.map((i) => ({
      id: i.id,
      sellableType: i.sellable_type,
      sellableId: i.sellable_id,
      supplierId: i.supplier_id,
      title: i.title,
      qty: i.qty,
      unitPriceMinor: i.unit_price_minor,
      amountMinor: i.amount_minor,
      status: i.status,
      vouchers: vouchers.filter((v) => v.order_item_id === i.id).map((v) => ({ code: v.code, status: v.status })),
    })),
  };
}

export async function loadOrder(db: Db, id: string) {
  const o = await maybeOne(db, `SELECT * FROM orders WHERE id = $1`, [id]);
  if (!o) return null;
  const items = await q(db, `SELECT * FROM order_items WHERE order_id = $1 ORDER BY sellable_type, id`, [id]);
  const vouchers = await q(db, `SELECT v.* FROM vouchers v JOIN order_items i ON i.id = v.order_item_id WHERE i.order_id = $1 ORDER BY v.code`, [id]);
  return { order: o, items, vouchers, dto: orderDto(o, items, vouchers) };
}

/** Supplier owned by the actor (approved unless allowPending). */
export async function supplierOf(db: Db, userId: string, opts: { allowPending?: boolean } = {}) {
  const s = await maybeOne(db, `SELECT * FROM suppliers WHERE owner_user_id = $1 ORDER BY (status = 'APPROVED') DESC, created_at DESC LIMIT 1`, [userId]);
  if (!s) throw forbidden('SUPPLIER_REQUIRED', 'You are not a registered supplier');
  if (!opts.allowPending && s.status !== 'APPROVED') throw forbidden('SUPPLIER_NOT_APPROVED', 'Your supplier account is not approved');
  return s;
}

// ------------------------------------------------------------------------------------------------
// orders
// ------------------------------------------------------------------------------------------------

export async function createOrder(tx: Tx, ctx: Ctx, input: { items: Array<{ departureId: string; qty: number; optionIds?: string[] }> }) {
  const buyerId = ctx.actor!.userId;
  const ids = input.items.map((i) => i.departureId);
  if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_DEPARTURE', 'Each departure may appear only once per order');
  const sorted = [...input.items].sort((a, b) => (a.departureId < b.departureId ? -1 : 1)); // stable lock order
  const lines: Array<{ type: 'TRAVEL_DEPARTURE' | 'TRAVEL_OPTION'; sellableId: string; supplierId: string; title: string; qty: number; unit: number; productId: string; departureId: string }> = [];
  const suppliers = new Map<string, { supplierId: string; payeeId: string; commissionBps: number; gross: number; mor: string; name: string }>();
  const terms: Record<string, unknown> = {};
  let currency: string | null = null;
  for (const it of sorted) {
    const d = await maybeOne(
      tx,
      `SELECT d.id AS departure_id, d.starts_at, d.status AS departure_status, d.price_minor AS departure_price,
              p.id AS product_id, p.title, p.status AS product_status, p.base_price_minor, p.currency, p.cancellation_terms,
              s.id AS supplier_id, s.status AS supplier_status, s.owner_user_id, s.commission_bps, s.merchant_of_record, s.name AS supplier_name
         FROM travel_departures d JOIN travel_products p ON p.id = d.product_id JOIN suppliers s ON s.id = p.supplier_id
        WHERE d.id = $1`,
      [it.departureId],
    );
    if (!d) throw notFound('Departure');
    if (d.product_status !== 'PUBLISHED' || d.supplier_status !== 'APPROVED') throw conflict('PRODUCT_UNAVAILABLE', 'This product is not on sale');
    if (new Date(d.starts_at).getTime() <= Date.now()) throw conflict('DEPARTURE_CLOSED', 'This departure has already started');
    if (!d.owner_user_id) throw conflict('PRODUCT_UNAVAILABLE', 'Supplier has no payee account');
    if (d.owner_user_id === buyerId) throw forbidden('SELF_PURCHASE', 'Suppliers cannot buy their own products');
    if (currency && currency !== d.currency) throw badRequest('CURRENCY_MISMATCH', 'All items in an order must share a currency');
    currency = d.currency;
    const unit = d.departure_price ?? d.base_price_minor;
    if (unit == null) throw unprocessable('PRICE_UNAVAILABLE', 'This departure has no price');
    const optionIds = [...new Set(it.optionIds ?? [])];
    const options = optionIds.length
      ? await q(tx, `SELECT * FROM travel_product_options WHERE id = ANY($1::uuid[]) AND product_id = $2 AND active`, [optionIds, d.product_id])
      : [];
    if (options.length !== optionIds.length) throw badRequest('INVALID_OPTION', 'One or more options are not available for this product');
    // atomic capacity reservation (TRAVEL-02): 0 rows → sold out
    const upd = await tx.query(
      `UPDATE travel_departures SET booked = booked + $2 WHERE id = $1 AND booked + $2 <= capacity AND status IN ('OPEN','GUARANTEED')`,
      [it.departureId, it.qty],
    );
    if (upd.rowCount === 0) throw conflict('SOLD_OUT', 'Not enough seats left on this departure');
    lines.push({ type: 'TRAVEL_DEPARTURE', sellableId: it.departureId, supplierId: d.supplier_id, title: d.title, qty: it.qty, unit, productId: d.product_id, departureId: it.departureId });
    for (const o of options) {
      lines.push({ type: 'TRAVEL_OPTION', sellableId: o.id, supplierId: d.supplier_id, title: `${d.title} · ${o.name}`, qty: it.qty, unit: o.price_minor, productId: d.product_id, departureId: it.departureId });
    }
    const gross = (unit + options.reduce((a: number, o: any) => a + o.price_minor, 0)) * it.qty;
    const s = suppliers.get(d.supplier_id) ?? { supplierId: d.supplier_id, payeeId: d.owner_user_id, commissionBps: d.commission_bps, gross: 0, mor: d.merchant_of_record, name: d.supplier_name };
    s.gross += gross;
    suppliers.set(d.supplier_id, s);
    terms[d.product_id] = d.cancellation_terms ?? {};
  }
  const mors = new Set([...suppliers.values()].map((s) => s.mor));
  if (mors.size > 1) throw badRequest('MIXED_MERCHANT_OF_RECORD', 'Items sold by JETPOOL and by suppliers directly must be ordered separately');
  const subtotal = lines.reduce((a, l) => a + l.unit * l.qty, 0);
  if (!Number.isSafeInteger(subtotal)) throw badRequest('AMOUNT_TOO_LARGE', 'Order amount is too large');
  const fees = await quoteFees(tx, { domain: 'TRAVEL', amountMinor: subtotal, currency: currency!, at: new Date() });
  const total = subtotal + fees.platformFeeMinor + fees.taxMinor;
  const supplierList = [...suppliers.values()].map((s) => ({
    supplierId: s.supplierId,
    payeeId: s.payeeId,
    supplierName: s.name,
    grossMinor: s.gross,
    commissionBps: s.commissionBps,
    commissionMinor: applyBps(s.gross, s.commissionBps),
  }));
  const pricing = {
    subtotalMinor: subtotal,
    platformFeeMinor: fees.platformFeeMinor,
    taxMinor: fees.taxMinor,
    totalMinor: total,
    rulesVersion: fees.rulesVersion,
    suppliers: supplierList,
    cancellationTerms: terms,
    quotedAt: new Date().toISOString(),
  };
  const order = await one(
    tx,
    `INSERT INTO orders(buyer_id, status, currency, subtotal_minor, fee_minor, total_minor, merchant_of_record, expires_at, pricing_snapshot)
     VALUES ($1,'PENDING',$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8) RETURNING *`,
    [buyerId, currency, subtotal, fees.platformFeeMinor + fees.taxMinor, total, [...mors][0], ctx.app.config.HOLD_TTL_SEC, JSON.stringify(pricing)],
  );
  // every option line points at the departure line it was booked with (several departures of one product may share
  // an order; refunds are computed per departure line with its own tier)
  const departureLine = new Map<string, string>();
  for (const l of lines) {
    const parent = l.type === 'TRAVEL_OPTION' ? departureLine.get(l.departureId) : null;
    if (l.type === 'TRAVEL_OPTION' && !parent) throw new Error(`option line without its departure line (${l.departureId})`);
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO order_items(order_id, sellable_type, sellable_id, supplier_id, title, qty, unit_price_minor, amount_minor, parent_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [order.id, l.type, l.sellableId, l.supplierId, l.title.slice(0, 300), l.qty, l.unit, l.unit * l.qty, parent ?? null],
    );
    if (l.type === 'TRAVEL_DEPARTURE') departureLine.set(l.departureId, row.id);
  }
  await recordTransition(tx, ctx, { aggregateType: 'order', aggregateId: order.id, from: null, to: 'PENDING', reason: 'CREATED' });
  await emit(tx, ctx, { aggregateType: 'order', aggregateId: order.id, eventType: 'order.created', payload: { orderId: order.id, buyerId, totalMinor: total, currency } });
  for (const it of sorted) {
    await emit(tx, ctx, { aggregateType: 'travel_departure', aggregateId: it.departureId, eventType: 'travel.inventory.changed', payload: { departureId: it.departureId, delta: it.qty, orderId: order.id } });
  }
  return (await loadOrder(tx, order.id))!.dto;
}

/** Give back the seats of every active departure line of the order (idempotent). */
export async function releaseCapacity(tx: Tx, ctx: Ctx, orderId: string) {
  const lines = await q(tx, `SELECT * FROM order_items WHERE order_id = $1 AND status = 'ACTIVE' ORDER BY sellable_id FOR UPDATE`, [orderId]);
  for (const l of lines) {
    if (l.sellable_type === 'TRAVEL_DEPARTURE') {
      await tx.query(`UPDATE travel_departures SET booked = greatest(booked - $2, 0) WHERE id = $1`, [l.sellable_id, l.qty]);
      await emit(tx, ctx, { aggregateType: 'travel_departure', aggregateId: l.sellable_id, eventType: 'travel.inventory.changed', payload: { departureId: l.sellable_id, delta: -l.qty, orderId } });
    }
  }
  await tx.query(`UPDATE order_items SET status = 'CANCELLED' WHERE order_id = $1 AND status = 'ACTIVE'`, [orderId]);
  await tx.query(`UPDATE vouchers SET status = 'VOID' WHERE status = 'ISSUED' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`, [orderId]);
}

interface Tier { min_hours_before: number; refund_pct: number }
const DEFAULT_TIERS: Tier[] = [
  { min_hours_before: 24, refund_pct: 100 },
  { min_hours_before: 0, refund_pct: 0 },
];

/** Refund percentage for a product's cancellation_terms {tiers:[{min_hours_before, refund_pct}], fee_refundable?}. */
export function refundPct(terms: any, hoursBefore: number): number {
  const tiers: Tier[] = Array.isArray(terms?.tiers) && terms.tiers.length ? terms.tiers : DEFAULT_TIERS;
  const sorted = [...tiers].sort((a, b) => b.min_hours_before - a.min_hours_before);
  for (const t of sorted) if (hoursBefore >= t.min_hours_before) return Math.max(0, Math.min(100, Math.trunc(t.refund_pct)));
  return 0;
}

/** Amount refundable now under each product's cancellation terms (server-side; capped by what is left). */
export async function cancellationRefund(db: Db, order: any): Promise<number> {
  return (await cancellationRefundBreakdown(db, order)).amountMinor;
}

/**
 * The cancellation refund and the part of it that returns the buyer service fee + tax (feeRefundMinor; 0 unless
 * every product's terms mark the fee refundable). Passed to PAY-02 so the ledger reverses only refunded components.
 */
export async function cancellationRefundBreakdown(db: Db, order: any): Promise<{ amountMinor: number; feeRefundMinor: number }> {
  const lines = await q(
    db,
    `SELECT i.*, d.starts_at, d.product_id FROM order_items i
       JOIN travel_departures d ON d.id = CASE WHEN i.sellable_type = 'TRAVEL_DEPARTURE' THEN i.sellable_id END
      WHERE i.order_id = $1 AND i.status = 'ACTIVE'`,
    [order.id],
  );
  const optionLines = await q(db, `SELECT i.*, o.product_id FROM order_items i JOIN travel_product_options o ON o.id = i.sellable_id WHERE i.order_id = $1 AND i.sellable_type = 'TRAVEL_OPTION' AND i.status = 'ACTIVE'`, [order.id]);
  const terms = order.pricing_snapshot?.cancellationTerms ?? {};
  // Each option line counts ONCE, with the departure line it was booked with (parent_item_id). Legacy lines without
  // the link go to the earliest departure of their product in the order (never to several departures).
  const byStart = [...lines].sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime() || (a.id < b.id ? -1 : 1));
  const optionsOf = new Map<string, number>();
  for (const o of optionLines) {
    const parent = o.parent_item_id ? lines.find((l) => l.id === o.parent_item_id) : byStart.find((l) => l.product_id === o.product_id);
    if (parent) optionsOf.set(parent.id, (optionsOf.get(parent.id) ?? 0) + o.amount_minor);
  }
  let refundSub = 0;
  let allFeeRefundable = true;
  for (const l of lines) {
    const hours = (new Date(l.starts_at).getTime() - Date.now()) / 3_600_000;
    if (hours <= 0) throw conflict('ALREADY_DEPARTED', 'A departure in this order has already started');
    const t = terms[l.product_id] ?? {};
    const pct = refundPct(t, hours);
    if (t.fee_refundable !== true) allFeeRefundable = false;
    refundSub += applyBps(l.amount_minor + (optionsOf.get(l.id) ?? 0), pct * 100);
  }
  const fee = order.total_minor - order.subtotal_minor;
  const feeRefund = allFeeRefundable && order.subtotal_minor > 0 ? Math.floor((fee * refundSub) / order.subtotal_minor) : 0;
  const amountMinor = Math.max(0, Math.min(order.total_minor - order.refunded_minor, refundSub + feeRefund));
  return { amountMinor, feeRefundMinor: Math.min(feeRefund, amountMinor) };
}

export async function cancelOrder(tx: Tx, ctx: Ctx, args: { orderId: string; reason: string; full?: boolean; requireBuyer?: string | null }) {
  const order = await maybeOne(tx, `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [args.orderId]);
  if (!order) throw notFound('Order');
  if (args.requireBuyer && order.buyer_id !== args.requireBuyer) throw notFound('Order');
  let refund: { refundId: string | null; status: string; amountMinor: number } = { refundId: null, status: 'NONE', amountMinor: 0 };
  if (UNPAID.includes(order.status)) {
    await OrderFSM.transition(tx, ctx, { table: 'orders', id: order.id, to: 'CANCELLED', reason: args.reason, versioned: true, set: { cancelled_at: new Date(), cancel_reason: args.reason.slice(0, 300) } });
    await releaseCapacity(tx, ctx, order.id);
  } else if (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED') {
    // a full refund returns every remaining component (pro rata reversal); a policy refund states its fee part
    const base: { amountMinor: number; feeRefundMinor: number | null } = args.full
      ? { amountMinor: order.total_minor - order.refunded_minor, feeRefundMinor: null }
      : await cancellationRefundBreakdown(tx, order);
    // refunds still in flight (requested / retrying) are already promised to the buyer: cap at what the payment can
    // still refund, under the payment lock, so one pending refund never makes the cancellation (or a whole departure
    // cancellation) fail with REFUND_EXCEEDS_REFUNDABLE
    const payment = await maybeOne<{ id: string; amount_minor: number; refunded_minor: number }>(
      tx,
      `SELECT id, amount_minor, refunded_minor FROM payments WHERE subject_type = 'ORDER' AND subject_id = $1 AND status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED') FOR UPDATE`,
      [order.id],
    );
    const amount = payment ? Math.max(0, Math.min(base.amountMinor, await refundableRemaining(tx, payment))) : base.amountMinor;
    const feeRefundMinor = base.feeRefundMinor == null ? null : Math.min(base.feeRefundMinor, amount);
    await OrderFSM.transition(tx, ctx, { table: 'orders', id: order.id, to: 'CANCELLED', reason: args.reason, versioned: true, set: { cancelled_at: new Date(), cancel_reason: args.reason.slice(0, 300) } });
    await releaseCapacity(tx, ctx, order.id);
    if (amount > 0) {
      const r = await requestRefund(tx, ctx, {
        subjectType: 'ORDER',
        subjectId: order.id,
        amountMinor: amount,
        feeRefundMinor,
        reason: `ORDER_CANCELLED: ${args.reason}`.slice(0, 300),
        idempotencyKey: `order-cancel:${order.id}`,
      });
      refund = { ...r, amountMinor: amount };
    }
  } else {
    throw conflict('INVALID_STATE_TRANSITION', `order is ${order.status} and cannot be cancelled`);
  }
  await emit(tx, ctx, { aggregateType: 'order', aggregateId: order.id, eventType: 'order.cancelled', payload: { orderId: order.id, reason: args.reason, refundMinor: refund.amountMinor, refundId: refund.refundId } });
  await notify(tx, ctx, {
    userId: order.buyer_id,
    templateKey: 'order.cancelled',
    title: '주문이 취소되었습니다',
    body: refund.amountMinor > 0 ? `주문 ${order.code} 취소 · 환불 ${refund.amountMinor} ${order.currency}` : `주문 ${order.code}이(가) 취소되었습니다`,
    data: { orderId: order.id },
    dedupeKey: `order.cancelled:${order.id}`,
  });
  return { order: (await loadOrder(tx, order.id))!.dto, refund };
}

// ------------------------------------------------------------------------------------------------
// ORDER payment subject (contract with PAY-01/02)
// ------------------------------------------------------------------------------------------------

/**
 * An unpaid order may only be paid while every active departure line can still be delivered:
 * not started yet (same gate as createOrder) and not CANCELLED/DEPARTED. The seats are already held,
 * so a departure merely CLOSED for new sales does not block paying an existing hold.
 */
async function assertDeparturesPayable(tx: Tx, orderId: string) {
  const closed = await maybeOne(
    tx,
    `SELECT d.id FROM order_items i JOIN travel_departures d ON d.id = i.sellable_id
      WHERE i.order_id = $1 AND i.status = 'ACTIVE' AND i.sellable_type = 'TRAVEL_DEPARTURE'
        AND (d.starts_at <= $2 OR d.status IN ('CANCELLED','DEPARTED'))
      LIMIT 1`,
    [orderId, new Date()],
  );
  if (closed) throw conflict('DEPARTURE_CLOSED', 'A departure in this order has already started or is no longer running');
}

export function registerOrderPaymentSubject() {
  registerPaymentSubject('ORDER', {
    async payable(tx, _ctx, orderId): Promise<PayableSnapshot> {
      const o = await maybeOne(tx, `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!o) throw notFound('Order');
      if (!UNPAID.includes(o.status)) throw conflict('ORDER_NOT_PAYABLE', `Order is ${o.status}`);
      if (o.expires_at && new Date(o.expires_at).getTime() <= Date.now()) throw conflict('ORDER_EXPIRED', 'This order has expired');
      await assertDeparturesPayable(tx, orderId);
      const items = await q(tx, `SELECT title FROM order_items WHERE order_id = $1 AND status = 'ACTIVE' AND sellable_type = 'TRAVEL_DEPARTURE' ORDER BY id`, [orderId]);
      const sup: any[] = o.pricing_snapshot?.suppliers ?? [];
      const tax = Number(o.pricing_snapshot?.taxMinor ?? 0);
      const taxParts = allocate(tax, sup.map((s) => s.grossMinor));
      return {
        payerId: o.buyer_id,
        amountMinor: o.total_minor,
        currency: o.currency,
        orderName: items.length > 1 ? `${items[0].title} 외 ${items.length - 1}건` : (items[0]?.title ?? `주문 ${o.code}`),
        split: sup.map((s, i) => ({ payeeId: s.payeeId, payeeType: 'SUPPLIER' as const, grossMinor: s.grossMinor, feeMinor: s.commissionMinor, taxMinor: taxParts[i] ?? 0 })),
        merchantOfRecord: o.merchant_of_record,
      };
    },
    async onPaymentCreated(tx, ctx, orderId) {
      const o = await maybeOne(tx, `SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (o && (o.status === 'PENDING' || o.status === 'PAYMENT_FAILED')) {
        await OrderFSM.transition(tx, ctx, { table: 'orders', id: orderId, to: 'PAYMENT_PENDING', reason: 'PAYMENT_CREATED', versioned: true });
      }
    },
    async onPaymentApproved(tx, ctx, orderId, payment) {
      const o = await maybeOne(tx, `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!o) throw notFound('Order');
      if (!UNPAID.includes(o.status)) throw conflict('ORDER_NOT_PAYABLE', `Order is ${o.status}`);
      if (payment.amountMinor !== o.total_minor || payment.currency !== o.currency) throw conflict('AMOUNT_MISMATCH', 'Payment does not match order total');
      // prepared before departure but captured after it started → rejected here; approvePayment auto-refunds
      await assertDeparturesPayable(tx, orderId);
      await OrderFSM.transition(tx, ctx, { table: 'orders', id: orderId, to: 'PAID', reason: `PAYMENT ${payment.id}`, actorType: 'PROVIDER', versioned: true, set: { expires_at: null } });
      const lines = await q(tx, `SELECT * FROM order_items WHERE order_id = $1 AND status = 'ACTIVE' AND sellable_type = 'TRAVEL_DEPARTURE'`, [orderId]);
      for (const l of lines) {
        for (let k = 0; k < l.qty; k++) await tx.query(`INSERT INTO vouchers(order_item_id, code) VALUES ($1,$2)`, [l.id, voucherCode()]);
      }
      await emit(tx, ctx, { aggregateType: 'order', aggregateId: orderId, eventType: 'order.paid', payload: { orderId, paymentId: payment.id, totalMinor: o.total_minor, currency: o.currency } });
      await notify(tx, ctx, {
        userId: o.buyer_id,
        templateKey: 'order.paid',
        title: '여행 상품 예약이 확정되었습니다',
        body: `주문 ${o.code} · 바우처가 발급되었습니다`,
        data: { orderId },
        dedupeKey: `order.paid:${orderId}`,
      });
      const owners = await q(
        tx,
        `SELECT DISTINCT s.owner_user_id FROM order_items i JOIN suppliers s ON s.id = i.supplier_id WHERE i.order_id = $1 AND s.owner_user_id IS NOT NULL`,
        [orderId],
      );
      for (const ow of owners) {
        await notify(tx, ctx, { userId: ow.owner_user_id, templateKey: 'supplier.order.paid', title: '새 주문이 결제되었습니다', body: `주문 ${o.code}`, data: { orderId }, dedupeKey: `supplier.order.paid:${orderId}` });
      }
    },
    async onPaymentFailed(tx, ctx, orderId) {
      const o = await maybeOne(tx, `SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (o?.status === 'PAYMENT_PENDING') await OrderFSM.transition(tx, ctx, { table: 'orders', id: orderId, to: 'PAYMENT_FAILED', reason: 'PAYMENT_FAILED', versioned: true });
    },
    async onRefunded(tx, ctx, orderId, refund) {
      const o = await maybeOne(tx, `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!o) return;
      await tx.query(`UPDATE orders SET refunded_minor = $2 WHERE id = $1`, [orderId, Math.min(refund.totalRefundedMinor, o.total_minor)]);
      if (['PAID', 'FULFILLED', 'PARTIALLY_REFUNDED'].includes(o.status)) {
        if (refund.fullyRefunded) {
          // REFUNDED is terminal: a buyer refunded in full (staff refund, PG console cancel synced by webhook) must not
          // keep redeemable vouchers, and seats of a departure that has not run yet go back on sale
          if (o.status === 'FULFILLED') {
            await tx.query(`UPDATE vouchers SET status = 'VOID' WHERE status = 'ISSUED' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`, [orderId]);
          } else {
            await releaseCapacity(tx, ctx, orderId);
          }
        }
        await OrderFSM.transition(tx, ctx, { table: 'orders', id: orderId, to: refund.fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', reason: `REFUND ${refund.refundId}`, versioned: true });
        if (refund.fullyRefunded) {
          await emit(tx, ctx, { aggregateType: 'order', aggregateId: orderId, eventType: 'order.refunded', payload: { orderId, refundId: refund.refundId, totalRefundedMinor: refund.totalRefundedMinor } });
        }
      }
    },
  });
}

// ------------------------------------------------------------------------------------------------
// jobs
// ------------------------------------------------------------------------------------------------

/** Unpaid orders past expires_at release their seats (skipped while a payment is still open/confirming). */
export async function expireOrders(app: AppContext, ctx: Ctx, limit = 200): Promise<number> {
  const rows = await q<{ id: string }>(
    app.pool,
    `SELECT o.id FROM orders o
      WHERE o.status IN ('PENDING','PAYMENT_PENDING','PAYMENT_FAILED') AND o.expires_at < now()
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.subject_type = 'ORDER' AND p.subject_id = o.id
                         AND (p.status = 'CONFIRMING' OR (p.status = 'CREATED' AND p.expires_at > now())))
      ORDER BY o.expires_at LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const { id } of rows) {
    await withTx(app.pool, async (tx) => {
      const o = await maybeOne(tx, `SELECT * FROM orders WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id]);
      if (!o || !UNPAID.includes(o.status) || !o.expires_at || new Date(o.expires_at).getTime() >= Date.now()) return;
      await OrderFSM.transition(tx, ctx, { table: 'orders', id, to: 'EXPIRED', reason: 'PAYMENT_WINDOW_EXPIRED', versioned: true });
      await releaseCapacity(tx, ctx, id);
      await emit(tx, ctx, { aggregateType: 'order', aggregateId: id, eventType: 'order.expired', payload: { orderId: id } });
      n++;
    });
  }
  return n;
}

const paidCountSql = `SELECT coalesce(sum(i.qty),0)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
   WHERE i.sellable_type = 'TRAVEL_DEPARTURE' AND i.sellable_id = $1 AND i.status = 'ACTIVE' AND o.status IN ('PAID','PARTIALLY_REFUNDED','FULFILLED')`;

/** Cancel a departure and every order on it (paid orders are fully refunded). */
export async function cancelDeparture(tx: Tx, ctx: Ctx, departureId: string, reason: string) {
  await DepartureFSM.transition(tx, ctx, { table: 'travel_departures', id: departureId, to: 'CANCELLED', reason });
  const orders = await q<{ order_id: string }>(
    tx,
    `SELECT DISTINCT i.order_id FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.sellable_type = 'TRAVEL_DEPARTURE' AND i.sellable_id = $1 AND i.status = 'ACTIVE'
        AND o.status IN ('PENDING','PAYMENT_PENDING','PAYMENT_FAILED','PAID','PARTIALLY_REFUNDED') ORDER BY i.order_id`,
    [departureId],
  );
  for (const o of orders) await cancelOrder(tx, ctx, { orderId: o.order_id, reason, full: true });
  await emit(tx, ctx, { aggregateType: 'travel_departure', aggregateId: departureId, eventType: 'travel.departure.cancelled', payload: { departureId, reason, orders: orders.length } });
  return orders.length;
}

/**
 * Minimum-participant guarantee (TRAVEL-02):
 *  - OPEN with paid participants >= min → GUARANTEED;
 *  - OPEN past cutoff (cutoff_at, default starts_at − 48h) below min → CANCELLED + full refunds;
 *  - started departures → DEPARTED; paid orders whose departures all started → FULFILLED.
 */
export async function runDepartureLifecycle(app: AppContext, ctx: Ctx): Promise<{ guaranteed: number; cancelled: number; departed: number; fulfilled: number }> {
  const out = { guaranteed: 0, cancelled: 0, departed: 0, fulfilled: 0 };
  const open = await q<{ id: string; min_participants: number; past_cutoff: boolean }>(
    app.pool,
    `SELECT id, min_participants, (coalesce(cutoff_at, starts_at - interval '48 hours') <= now()) AS past_cutoff
       FROM travel_departures WHERE status = 'OPEN' AND starts_at > now() ORDER BY starts_at LIMIT 500`,
  );
  for (const d of open) {
    await withTx(app.pool, async (tx) => {
      const locked = await maybeOne(tx, `SELECT status FROM travel_departures WHERE id = $1 FOR UPDATE SKIP LOCKED`, [d.id]);
      if (!locked || locked.status !== 'OPEN') return;
      const { n } = await one<{ n: number }>(tx, paidCountSql, [d.id]);
      if (n >= d.min_participants) {
        await DepartureFSM.transition(tx, ctx, { table: 'travel_departures', id: d.id, from: 'OPEN', to: 'GUARANTEED', reason: 'MIN_PARTICIPANTS_REACHED' });
        await emit(tx, ctx, { aggregateType: 'travel_departure', aggregateId: d.id, eventType: 'travel.departure.guaranteed', payload: { departureId: d.id, participants: n } });
        out.guaranteed++;
      } else if (d.past_cutoff) {
        await cancelDeparture(tx, ctx, d.id, 'MIN_PARTICIPANTS_NOT_MET');
        out.cancelled++;
      }
    });
  }
  const started = await q<{ id: string }>(app.pool, `SELECT id FROM travel_departures WHERE status IN ('OPEN','GUARANTEED','CLOSED') AND starts_at <= now() LIMIT 500`);
  for (const d of started) {
    await withTx(app.pool, async (tx) => {
      const locked = await maybeOne(tx, `SELECT status FROM travel_departures WHERE id = $1 FOR UPDATE SKIP LOCKED`, [d.id]);
      if (!locked || !['OPEN', 'GUARANTEED', 'CLOSED'].includes(locked.status)) return;
      await DepartureFSM.transition(tx, ctx, { table: 'travel_departures', id: d.id, to: 'DEPARTED', reason: 'STARTED' });
      out.departed++;
    });
  }
  const fulfil = await q<{ id: string }>(
    app.pool,
    `SELECT o.id FROM orders o WHERE o.status IN ('PAID','PARTIALLY_REFUNDED')
        AND NOT EXISTS (SELECT 1 FROM order_items i JOIN travel_departures d ON d.id = i.sellable_id
                         WHERE i.order_id = o.id AND i.sellable_type = 'TRAVEL_DEPARTURE' AND i.status = 'ACTIVE' AND d.starts_at > now())
        AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.status = 'ACTIVE')
      LIMIT 500`,
  );
  for (const o of fulfil) {
    await withTx(app.pool, async (tx) => {
      const locked = await maybeOne(tx, `SELECT status FROM orders WHERE id = $1 FOR UPDATE SKIP LOCKED`, [o.id]);
      if (!locked || !['PAID', 'PARTIALLY_REFUNDED'].includes(locked.status)) return;
      await OrderFSM.transition(tx, ctx, { table: 'orders', id: o.id, to: 'FULFILLED', reason: 'DEPARTED', versioned: true, set: { fulfilled_at: new Date() } });
      await emit(tx, ctx, { aggregateType: 'order', aggregateId: o.id, eventType: 'order.fulfilled', payload: { orderId: o.id } });
      out.fulfilled++;
    });
  }
  return out;
}

export async function auditSupplierDecision(tx: Tx, ctx: Ctx, supplierId: string, before: any, after: any, reason?: string) {
  await audit(tx, ctx, { action: 'supplier.decision', resourceType: 'supplier', resourceId: supplierId, category: 'COMPLIANCE', before, after, reason: reason ?? null });
}
