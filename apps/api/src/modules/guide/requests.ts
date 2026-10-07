import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { assertEnabled } from '../../platform/flags.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { decodeCursor, page } from '../../platform/http.js';
import { GuideRequestFsm, OPEN_REQUEST_STATUSES, isPaidType, type GuideRequestStatus } from './fsm.js';
import { getProfile, type GuideProfileRow } from './profile.js';
import { assertGuideWindowFree } from './availability.js';
import { searchGuides } from './search.js';
import { createBookingFromOffer, type GuideBookingRow } from './bookings.js';
import type { CounterInput, OfferInput, RequestCreateInput } from './schemas.js';

export interface GuideRequestRow {
  id: string;
  traveler_id: string;
  guide_id: string | null;
  start_at: Date;
  end_at: Date;
  party_size: number;
  city: string | null;
  languages: string[];
  interests: string[];
  scope: any;
  message: string | null;
  status: GuideRequestStatus;
  current_offer_version: number;
  created_at: Date;
}
export interface GuideOfferRow {
  id: string;
  request_id: string;
  version: number;
  created_by: string;
  start_at: Date;
  end_at: Date;
  paid: boolean;
  price_minor: number;
  currency: string;
  itinerary: string | null;
  status: 'OPEN' | 'SUPERSEDED' | 'ACCEPTED' | 'DECLINED';
  created_at: Date;
}

const RT = 'guide_requests';
/** Open requests expire after this long even if their start is still in the future. */
export const REQUEST_TTL_MS = 7 * 24 * 3600_000;
/** Number of guides notified for an open (undirected) request. */
export const OPEN_REQUEST_FANOUT = 5;
const MAX_ACTIVITY_MS = 14 * 24 * 3600_000;

const rev = (db: Db, ctx: Ctx, r: { id: string }, eventType: string, payload: Record<string, unknown>) =>
  emit(db, ctx, { aggregateType: 'guide_request', aggregateId: r.id, eventType, payload: { requestId: r.id, ...payload } });

function assertWindow(startAt: Date, endAt: Date) {
  if (endAt <= startAt) throw badRequest('INVALID_RANGE', 'endAt must be after startAt');
  if (startAt.getTime() <= Date.now()) throw unprocessable('START_IN_PAST', 'startAt must be in the future');
  if (endAt.getTime() - startAt.getTime() > MAX_ACTIVITY_MS) throw badRequest('RANGE_TOO_LARGE', 'An activity may span at most 14 days');
}

async function lockRequest(db: Db, id: string): Promise<GuideRequestRow> {
  const r = await maybeOne<GuideRequestRow>(db, `SELECT * FROM ${RT} WHERE id = $1 FOR UPDATE`, [id]);
  if (!r) throw notFound('Guide request');
  return r;
}

async function publishedGuide(db: Db, guideId: string, lock = false): Promise<GuideProfileRow> {
  const g = await getProfile(db, guideId, lock);
  if (!g || g.status !== 'PUBLISHED') throw unprocessable('GUIDE_NOT_AVAILABLE', 'The guide is not published');
  const u = await maybeOne<{ status: string }>(db, `SELECT status FROM users WHERE id = $1`, [guideId]);
  if (u?.status !== 'ACTIVE') throw unprocessable('GUIDE_NOT_AVAILABLE', 'The guide is not active');
  return g;
}

/** Paid predicates are rechecked at every money-relevant step (offer, accept): type, live gate, flag. */
async function assertPaidAllowed(db: Db, g: GuideProfileRow, paid: boolean, priceMinor: number) {
  if (!isPaidType(g.guide_type)) {
    if (paid || priceMinor !== 0) throw unprocessable('FREE_GUIDE_PRICE_NOT_ALLOWED', `${g.guide_type} guides only offer free activities`);
    return;
  }
  if (!paid) throw unprocessable('PAID_FLAG_MISMATCH', `${g.guide_type} guide offers must be paid`);
  await assertEnabled(db, 'guide.paid', { userId: g.user_id });
  if (!g.paid_enabled) throw forbidden('GUIDE_PAID_NOT_ENABLED', 'Paid guiding is not enabled for this guide');
  if (priceMinor <= 0) throw unprocessable('PRICE_REQUIRED', 'Paid offers need a positive price');
}

// ---------------------------------------------------------------- create

export async function createRequest(tx: Tx, ctx: Ctx, actor: Actor, b: RequestCreateInput): Promise<GuideRequestRow> {
  const startAt = new Date(b.startAt), endAt = new Date(b.endAt);
  assertWindow(startAt, endAt);
  if (b.guideId) {
    if (b.guideId === actor.userId) throw unprocessable('SELF_REQUEST', 'You cannot request yourself as a guide');
    const g = await publishedGuide(tx, b.guideId);
    if (b.partySize > g.max_group_size) throw unprocessable('PARTY_TOO_LARGE', `This guide accepts at most ${g.max_group_size} people`);
  }
  const langs = b.languages.map((x) => x.toLowerCase());
  const interests = b.interests.map((x) => x.toLowerCase());
  const r = await one<GuideRequestRow>(
    tx,
    `INSERT INTO ${RT}(traveler_id, guide_id, start_at, end_at, party_size, city, languages, interests, scope, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [actor.userId, b.guideId ?? null, startAt, endAt, b.partySize, b.city ?? null, langs, interests, JSON.stringify(b.scope ?? {}), b.message ?? null],
  );
  await rev(tx, ctx, r, 'guide.requested', { travelerId: actor.userId, guideId: r.guide_id, open: !r.guide_id, startAt, endAt, city: r.city });
  if (r.guide_id) {
    await notify(tx, ctx, {
      userId: r.guide_id, templateKey: 'guide.request.received', title: '새 가이드 요청이 도착했습니다', body: 'A traveler sent you a guide request.',
      data: { requestId: r.id }, dedupeKey: `guide-request:${r.id}:received`,
    });
  } else {
    await notifyMatchingGuides(tx, ctx, r);
  }
  return r;
}

/** GUIDE-03 matching for open requests: notify the top-N eligible guides (notify() is idempotent by dedupe key). */
export async function notifyMatchingGuides(tx: Tx, ctx: Ctx, r: GuideRequestRow): Promise<string[]> {
  const matches = await searchGuides(tx, {
    city: r.city ?? undefined, languages: r.languages, interests: r.interests, types: [], pricing: 'any',
    from: r.start_at, to: r.end_at, availableOnly: false, limit: OPEN_REQUEST_FANOUT * 3, excludeUserId: r.traveler_id,
  });
  const eligible = matches.filter((m) => m.availability !== 'UNAVAILABLE' && m.guide.maxGroupSize >= r.party_size).slice(0, OPEN_REQUEST_FANOUT);
  for (const m of eligible) {
    await notify(tx, ctx, {
      userId: m.guide.guideId, templateKey: 'guide.request.match', title: '조건에 맞는 가이드 요청이 있습니다',
      body: 'A traveler is looking for a guide that matches your profile.', data: { requestId: r.id, score: m.score, why: m.explanation },
      dedupeKey: `guide-request:${r.id}:match`,
    });
  }
  if (eligible.length) await rev(tx, ctx, r, 'guide.request.matched', { guideIds: eligible.map((m) => m.guide.guideId) });
  return eligible.map((m) => m.guide.guideId);
}

// ---------------------------------------------------------------- read

async function canSeeOpenRequest(db: Db, actor: Actor) {
  const g = await getProfile(db, actor.userId);
  return !!g && g.status === 'PUBLISHED';
}

export async function getRequestFor(db: Db, actor: Actor, id: string) {
  const r = await maybeOne<GuideRequestRow>(db, `SELECT * FROM ${RT} WHERE id = $1`, [id]);
  if (!r) throw notFound('Guide request');
  const isParty = r.traveler_id === actor.userId || r.guide_id === actor.userId;
  const openView = !r.guide_id && r.status === 'REQUESTED' && (await canSeeOpenRequest(db, actor));
  if (!isParty && !openView) throw notFound('Guide request');
  const offers = isParty ? await q<GuideOfferRow>(db, `SELECT * FROM guide_offers WHERE request_id = $1 ORDER BY version`, [id]) : [];
  const booking = isParty ? await maybeOne(db, `SELECT id, status FROM guide_bookings WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]) : null;
  return { ...r, offers, booking };
}

export async function listRequests(db: Db, actor: Actor, f: { role?: 'traveler' | 'guide' | 'open'; limit: number; cursor?: string }) {
  const c = decodeCursor(f.cursor);
  if (f.role === 'open') {
    const g = await getProfile(db, actor.userId);
    if (!g || g.status !== 'PUBLISHED') throw forbidden('GUIDE_REQUIRED', 'Only published guides can browse open requests');
    const rows = await q<GuideRequestRow>(
      db,
      `SELECT * FROM ${RT} WHERE guide_id IS NULL AND status = 'REQUESTED' AND traveler_id <> $1 AND start_at > now()
          AND ($2::text IS NULL OR lower(city) = lower($2)) AND party_size <= $3
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $6`,
      [actor.userId, g.city, g.max_group_size, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
    );
    return page(rows, f.limit);
  }
  const rows = await q<GuideRequestRow>(
    db,
    `SELECT * FROM ${RT}
      WHERE (($2::text IS NULL AND (traveler_id = $1 OR guide_id = $1)) OR ($2 = 'traveler' AND traveler_id = $1) OR ($2 = 'guide' AND guide_id = $1))
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [actor.userId, f.role ?? null, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  return page(rows, f.limit);
}

// ---------------------------------------------------------------- negotiation

async function insertOffer(
  tx: Tx, r: GuideRequestRow, createdBy: string, o: { startAt: Date; endAt: Date; paid: boolean; priceMinor: number; currency: string; itinerary?: string },
): Promise<GuideOfferRow> {
  await tx.query(`UPDATE guide_offers SET status = 'SUPERSEDED' WHERE request_id = $1 AND status = 'OPEN'`, [r.id]);
  return one<GuideOfferRow>(
    tx,
    `INSERT INTO guide_offers(request_id, version, created_by, start_at, end_at, paid, price_minor, currency, itinerary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [r.id, r.current_offer_version + 1, createdBy, o.startAt, o.endAt, o.paid, o.paid ? o.priceMinor : 0, o.currency, o.itinerary ?? null],
  );
}

/** Guide offer (first offer, revision, or reply to a traveler counter). An open request is claimed by the first offering guide. */
export async function createOffer(tx: Tx, ctx: Ctx, actor: Actor, requestId: string, b: OfferInput) {
  const r = await lockRequest(tx, requestId);
  if (r.traveler_id === actor.userId) throw forbidden('NOT_REQUEST_GUIDE', 'Travelers cannot offer on their own request');
  if (r.guide_id && r.guide_id !== actor.userId) throw forbidden('NOT_REQUEST_GUIDE', 'This request is addressed to another guide');
  if (!OPEN_REQUEST_STATUSES.includes(r.status)) throw conflict('INVALID_STATE_TRANSITION', `Guide request is ${r.status}`, { from: r.status, to: 'OFFERED' });
  const g = await publishedGuide(tx, actor.userId);
  if (r.party_size > g.max_group_size) throw unprocessable('PARTY_TOO_LARGE', `Your maximum group size is ${g.max_group_size}`);
  await assertPaidAllowed(tx, g, b.paid, b.priceMinor);
  const startAt = new Date(b.startAt), endAt = new Date(b.endAt);
  assertWindow(startAt, endAt);
  await assertGuideWindowFree(tx, actor.userId, startAt, endAt);
  const offer = await insertOffer(tx, r, actor.userId, { startAt, endAt, paid: b.paid, priceMinor: b.priceMinor, currency: g.currency, itinerary: b.itinerary });
  const { row } = await GuideRequestFsm.transition(tx, ctx, {
    table: RT, id: r.id, to: 'OFFERED', reason: `offer v${offer.version}`,
    set: { current_offer_version: offer.version, ...(r.guide_id ? {} : { guide_id: actor.userId }) }, metadata: { offerVersion: offer.version },
  });
  await rev(tx, ctx, r, 'guide.offer.created', { offerId: offer.id, version: offer.version, guideId: actor.userId, travelerId: r.traveler_id, paid: offer.paid, priceMinor: offer.price_minor, currency: offer.currency, kind: 'OFFER' });
  await notify(tx, ctx, {
    userId: r.traveler_id, templateKey: 'guide.offer.received', title: '가이드 제안이 도착했습니다', body: 'A guide sent you an offer.',
    data: { requestId: r.id, offerVersion: offer.version }, dedupeKey: `guide-request:${r.id}:offer:${offer.version}`,
  });
  return { request: row as GuideRequestRow, offer };
}

/** Traveler counter-offer → new offer version, COUNTERED; the guide must respond (accept or re-offer). */
export async function counterOffer(tx: Tx, ctx: Ctx, actor: Actor, requestId: string, b: CounterInput) {
  const r = await lockRequest(tx, requestId);
  if (r.traveler_id !== actor.userId) throw forbidden('NOT_REQUEST_TRAVELER', 'Only the traveler can counter');
  if (!['OFFERED', 'COUNTERED'].includes(r.status) || !r.guide_id) throw conflict('INVALID_STATE_TRANSITION', `Guide request is ${r.status}`, { from: r.status, to: 'COUNTERED' });
  const g = await publishedGuide(tx, r.guide_id);
  const paid = isPaidType(g.guide_type);
  await assertPaidAllowed(tx, g, paid, b.priceMinor);
  const startAt = new Date(b.startAt), endAt = new Date(b.endAt);
  assertWindow(startAt, endAt);
  const offer = await insertOffer(tx, r, actor.userId, { startAt, endAt, paid, priceMinor: b.priceMinor, currency: g.currency, itinerary: b.itinerary });
  const { row } = await GuideRequestFsm.transition(tx, ctx, {
    table: RT, id: r.id, to: 'COUNTERED', reason: `counter v${offer.version}`, set: { current_offer_version: offer.version }, metadata: { offerVersion: offer.version },
  });
  await rev(tx, ctx, r, 'guide.offer.created', { offerId: offer.id, version: offer.version, guideId: r.guide_id, travelerId: r.traveler_id, paid: offer.paid, priceMinor: offer.price_minor, currency: offer.currency, kind: 'COUNTER' });
  await notify(tx, ctx, {
    userId: r.guide_id, templateKey: 'guide.offer.countered', title: '여행자가 수정 제안을 보냈습니다', body: 'The traveler sent a counter-offer.',
    data: { requestId: r.id, offerVersion: offer.version }, dedupeKey: `guide-request:${r.id}:offer:${offer.version}`,
  });
  return { request: row as GuideRequestRow, offer };
}

/**
 * Accept the CURRENT offer version (optimistic version check). Only the party that did not create the
 * offer may accept. Creates the guide booking (free → CONFIRMED, paid → ACCEPTED awaiting payment).
 */
export async function acceptOffer(tx: Tx, ctx: Ctx, actor: Actor, requestId: string, offerVersion: number): Promise<{ request: GuideRequestRow; offer: GuideOfferRow; booking: GuideBookingRow }> {
  const r = await lockRequest(tx, requestId);
  if (r.traveler_id !== actor.userId && r.guide_id !== actor.userId) throw notFound('Guide request');
  if (!['OFFERED', 'COUNTERED'].includes(r.status) || !r.guide_id) throw conflict('INVALID_STATE_TRANSITION', `Guide request is ${r.status}`, { from: r.status, to: 'ACCEPTED' });
  if (offerVersion !== r.current_offer_version) {
    throw conflict('OFFER_VERSION_MISMATCH', 'The offer has changed; review the latest version', { currentOfferVersion: r.current_offer_version });
  }
  const offer = await maybeOne<GuideOfferRow>(tx, `SELECT * FROM guide_offers WHERE request_id = $1 AND version = $2 FOR UPDATE`, [r.id, offerVersion]);
  if (!offer || offer.status !== 'OPEN') throw conflict('OFFER_NOT_OPEN', 'The offer is no longer open');
  if (offer.created_by === actor.userId) throw forbidden('CANNOT_ACCEPT_OWN_OFFER', 'The other party must accept this offer');
  if (offer.start_at.getTime() <= Date.now()) throw unprocessable('START_IN_PAST', 'The offered start time has passed');
  const g = await publishedGuide(tx, r.guide_id, true);
  await assertPaidAllowed(tx, g, offer.paid, offer.price_minor);
  await assertGuideWindowFree(tx, r.guide_id, offer.start_at, offer.end_at);
  await tx.query(`UPDATE guide_offers SET status = 'ACCEPTED' WHERE id = $1`, [offer.id]);
  const { row } = await GuideRequestFsm.transition(tx, ctx, { table: RT, id: r.id, to: 'ACCEPTED', reason: `accepted v${offerVersion}`, metadata: { offerVersion } });
  const booking = await createBookingFromOffer(tx, ctx, {
    requestId: r.id, offerId: offer.id, guideId: r.guide_id, travelerId: r.traveler_id, guideType: g.guide_type,
    startAt: offer.start_at, endAt: offer.end_at, paid: offer.paid, priceMinor: offer.price_minor, currency: offer.currency,
  });
  await rev(tx, ctx, r, 'guide.offer.accepted', { offerId: offer.id, version: offerVersion, acceptedBy: actor.userId, bookingId: booking.id, paid: offer.paid, guideId: r.guide_id, travelerId: r.traveler_id });
  const other = actor.userId === r.traveler_id ? r.guide_id : r.traveler_id;
  await notify(tx, ctx, {
    userId: other, templateKey: 'guide.offer.accepted', title: '제안이 수락되었습니다', body: 'Your guide offer was accepted.',
    data: { requestId: r.id, bookingId: booking.id }, dedupeKey: `guide-request:${r.id}:accepted`,
  });
  return { request: row as GuideRequestRow, offer: { ...offer, status: 'ACCEPTED' }, booking };
}

/** The party that has to respond declines (guide declines a request/counter; traveler declines a guide offer). */
export async function declineRequest(tx: Tx, ctx: Ctx, actor: Actor, requestId: string, reason?: string) {
  const r = await lockRequest(tx, requestId);
  const isTraveler = r.traveler_id === actor.userId, isGuide = !!r.guide_id && r.guide_id === actor.userId;
  if (!isTraveler && !isGuide) throw notFound('Guide request');
  if (!OPEN_REQUEST_STATUSES.includes(r.status)) throw conflict('INVALID_STATE_TRANSITION', `Guide request is ${r.status}`, { from: r.status, to: 'DECLINED' });
  const mustRespond = r.status === 'OFFERED' ? isTraveler : isGuide; // REQUESTED/COUNTERED await the guide
  if (!mustRespond) throw forbidden('NOT_YOUR_TURN', 'Only the party that must respond can decline; travelers may cancel instead');
  await tx.query(`UPDATE guide_offers SET status = 'DECLINED' WHERE request_id = $1 AND status = 'OPEN'`, [r.id]);
  const { row } = await GuideRequestFsm.transition(tx, ctx, { table: RT, id: r.id, to: 'DECLINED', reason: reason ?? `declined by ${isGuide ? 'guide' : 'traveler'}` });
  await rev(tx, ctx, r, 'guide.request.declined', { declinedBy: isGuide ? 'GUIDE' : 'TRAVELER', reason: reason ?? null });
  await notify(tx, ctx, {
    userId: isGuide ? r.traveler_id : r.guide_id!, templateKey: 'guide.request.declined', title: '가이드 요청이 거절되었습니다', body: 'The guide request was declined.',
    data: { requestId: r.id }, dedupeKey: `guide-request:${r.id}:declined`,
  });
  return row as GuideRequestRow;
}

export async function cancelRequest(tx: Tx, ctx: Ctx, actor: Actor, requestId: string, reason?: string) {
  const r = await lockRequest(tx, requestId);
  if (r.traveler_id !== actor.userId) {
    if (r.guide_id === actor.userId) throw forbidden('NOT_REQUEST_TRAVELER', 'Only the traveler can cancel a request; guides decline');
    throw notFound('Guide request');
  }
  if (!OPEN_REQUEST_STATUSES.includes(r.status)) throw conflict('INVALID_STATE_TRANSITION', `Guide request is ${r.status}`, { from: r.status, to: 'CANCELLED' });
  await tx.query(`UPDATE guide_offers SET status = 'DECLINED' WHERE request_id = $1 AND status = 'OPEN'`, [r.id]);
  const { row } = await GuideRequestFsm.transition(tx, ctx, { table: RT, id: r.id, to: 'CANCELLED', reason: reason ?? 'cancelled by traveler' });
  await rev(tx, ctx, r, 'guide.request.cancelled', { reason: reason ?? null });
  if (r.guide_id) {
    await notify(tx, ctx, {
      userId: r.guide_id, templateKey: 'guide.request.cancelled', title: '가이드 요청이 취소되었습니다', body: 'The traveler cancelled the request.',
      data: { requestId: r.id }, dedupeKey: `guide-request:${r.id}:cancelled`,
    });
  }
  return row as GuideRequestRow;
}

/** Job: expire negotiations whose start has passed or that are older than REQUEST_TTL_MS. */
export async function expireRequests(app: AppContext): Promise<number> {
  const ids = await q<{ id: string }>(
    app.pool,
    `SELECT id FROM ${RT} WHERE status = ANY($1::text[]) AND (start_at <= now() OR created_at + make_interval(secs => $2) <= now()) LIMIT 500`,
    [OPEN_REQUEST_STATUSES, REQUEST_TTL_MS / 1000],
  );
  let n = 0;
  for (const { id } of ids) {
    try {
      await withTx(app.pool, async (tx) => {
        const ctx = systemCtx(app, `job-guide-request-expiry-${id}`);
        const r = await maybeOne<GuideRequestRow>(tx, `SELECT * FROM ${RT} WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id]);
        if (!r || !OPEN_REQUEST_STATUSES.includes(r.status)) return;
        await tx.query(`UPDATE guide_offers SET status = 'DECLINED' WHERE request_id = $1 AND status = 'OPEN'`, [id]);
        await GuideRequestFsm.transition(tx, ctx, { table: RT, id, to: 'EXPIRED', reason: 'request expired', actorType: 'SYSTEM' });
        await rev(tx, ctx, r, 'guide.request.expired', { travelerId: r.traveler_id, guideId: r.guide_id });
        n++;
      });
    } catch (err) {
      app.log.warn({ err, requestId: id }, 'guide request expiry failed');
    }
  }
  return n;
}
