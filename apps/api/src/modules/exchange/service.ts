/**
 * EXCH-01..06 Home Exchange domain service.
 *
 * Exchange is an independent FSM (invariant 2): it never touches reservation tables. It shares the
 * calendar only through platform/inventory (acquireBlock/releaseBlock/isRangeFree) and confirms by
 * blocking BOTH homes atomically (invariant 6) — if either block fails nothing remains.
 */
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { StateMachine, recordTransition } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { assertEnabled } from '../../platform/flags.js';
import { acquireBlock, assertDateRange, isRangeFree, releaseBlock } from '../../platform/inventory.js';
import { canonicalJson, sha256 } from '../../platform/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../platform/errors.js';
import { hasRole } from '../../platform/auth.js';
import { decodeCursor, encodeCursor, isCalendarDate } from '../../platform/http.js';
import type { DomainEvent } from '../../platform/outbox.js';
import { ensureConversation } from '../messaging/service.js';
import { assertElevatedAccess, openDispute } from '../disputes/service.js';

export const EXCHANGE_FLAG = 'exchange.enabled';
/** A recipient has this long to respond to the latest offer before the request EXPIRES. */
export const OFFER_TTL_DAYS = 7;
/** Unilateral cancellation of a CONFIRMED exchange closer than this to the earliest start is a LATE cancellation. */
export const LATE_CANCEL_DAYS = 14;

export type ExchangeStatus =
  | 'REQUESTED' | 'COUNTERED' | 'MUTUAL_ACCEPTED' | 'VERIFICATION_PENDING' | 'AGREEMENT_PENDING' | 'CONFIRMED'
  | 'IN_PROGRESS' | 'COMPLETED' | 'REVIEWED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED' | 'DISPUTED' | 'CANCELLED';

const PRE_CONFIRMED: ExchangeStatus[] = ['REQUESTED', 'COUNTERED', 'MUTUAL_ACCEPTED', 'VERIFICATION_PENDING', 'AGREEMENT_PENDING'];
const NEGOTIABLE: ExchangeStatus[] = ['REQUESTED', 'COUNTERED'];
const ADDRESS_VISIBLE: ExchangeStatus[] = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED', 'DISPUTED'];

export const exchangeFsm = new StateMachine<ExchangeStatus>('EXCHANGE', {
  REQUESTED: ['COUNTERED', 'MUTUAL_ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED'],
  COUNTERED: ['COUNTERED', 'MUTUAL_ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED'],
  MUTUAL_ACCEPTED: ['VERIFICATION_PENDING', 'CANCELLED'],
  VERIFICATION_PENDING: ['AGREEMENT_PENDING', 'CANCELLED'],
  AGREEMENT_PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PROGRESS', 'DISPUTED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'DISPUTED'],
  COMPLETED: ['REVIEWED'],
  REVIEWED: [],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [],
  // left only through TRUST-03 dispute resolution (applyDisputeResolution): restore, cancel (blocks released) or complete
  DISPUTED: ['CONFIRMED', 'IN_PROGRESS', 'CANCELLED', 'COMPLETED'],
  CANCELLED: [],
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

export interface DateRange { start: string; end: string }

interface ExchangeRow {
  id: string;
  requester_id: string;
  responder_id: string;
  property_a_id: string;
  property_b_id: string;
  dates_a: string;
  dates_b: string;
  status: ExchangeStatus;
  current_offer_version: number;
  last_offer_by: string | null;
  accepted_a_version: number | null;
  accepted_b_version: number | null;
  conversation_id: string | null;
  version: number;
  respond_by: string | Date | null;
  confirmed_at: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  cancelled_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

type Party = 'A' | 'B';

const RANGE_RE = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/;
export function parseRange(r: string): DateRange {
  const m = RANGE_RE.exec(r);
  if (!m) throw new Error(`unexpected daterange literal ${r}`);
  return { start: m[1], end: m[2] };
}
const rangeLiteral = (r: DateRange) => `[${r.start},${r.end})`;
export const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

function requireActor(ctx: Ctx) {
  if (!ctx.actor) throw unauthorized();
  return ctx.actor;
}

function partyOf(ex: Pick<ExchangeRow, 'requester_id' | 'responder_id'>, userId: string | undefined | null): Party | null {
  if (!userId) return null;
  if (ex.requester_id === userId) return 'A';
  if (ex.responder_id === userId) return 'B';
  return null;
}
const otherUser = (ex: ExchangeRow, p: Party) => (p === 'A' ? ex.responder_id : ex.requester_id);
/**
 * Staff who may open an exchange case file (dispute / trust & safety / support desk), AAL2 only, every read audited.
 * Private P2P content (offer messages) and the exact addresses additionally need a case-scoped elevated-access grant
 * on the exchange conversation (invariant 10), see staffContentGrant.
 */
const EXCHANGE_STAFF_ROLES = ['ADMIN', 'SUPPORT', 'COMPLIANCE'] as const;
const canStaffRead = (ctx: Ctx) => !!ctx.actor && ctx.actor.aal === 'aal2' && hasRole(ctx.actor, ...EXCHANGE_STAFF_ROLES);

/** Active elevated-access grant of this staff member on the exchange conversation (audited by TRUST-03), or null. */
async function staffContentGrant(db: Db, ctx: Ctx, conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null;
  try {
    return (await assertElevatedAccess(db, ctx, conversationId)).grantId;
  } catch (err) {
    if (err instanceof AppError && (err.code === 'ELEVATED_ACCESS_REQUIRED' || err.code === 'AAL2_REQUIRED')) return null;
    throw err;
  }
}

/** Load + row-lock an exchange; non-parties get 404 (existence is not leaked). */
async function lockForParty(db: Db, ctx: Ctx, id: string, opts: { allowSystem?: boolean } = {}) {
  const ex = await maybeOne<ExchangeRow>(db, `SELECT * FROM exchange_requests WHERE id = $1 FOR UPDATE`, [id]);
  if (!ex) throw notFound('Exchange');
  if (!ctx.actor) {
    if (opts.allowSystem) return { ex, party: null as Party | null };
    throw unauthorized();
  }
  const party = partyOf(ex, ctx.actor.userId);
  if (!party) throw notFound('Exchange');
  return { ex, party };
}

function assertStatus(ex: ExchangeRow, allowed: ExchangeStatus[], to?: ExchangeStatus) {
  if (!allowed.includes(ex.status)) {
    throw conflict('INVALID_STATE_TRANSITION', `Exchange is ${ex.status}, expected ${allowed.join('|')}`, { from: ex.status, to });
  }
}

/** Real calendar days only ('2027-02-30' / '2027-13-01' never reach a `::date` cast). */
function assertCalendarRange(r: DateRange, label = 'dates') {
  if (!isCalendarDate(r.start) || !isCalendarDate(r.end)) throw badRequest('INVALID_DATE', `${label} must be real calendar dates (YYYY-MM-DD)`);
  assertDateRange(r.start, r.end);
}

function assertFutureRange(r: DateRange, label: string) {
  assertCalendarRange(r, label);
  if (r.start < todayUtc()) throw unprocessable('DATES_IN_PAST', `${label} must not start in the past`);
}

async function currentOffer(db: Db, exchangeId: string, version: number) {
  return one<any>(db, `SELECT * FROM exchange_offers WHERE exchange_id = $1 AND version = $2`, [exchangeId, version]);
}

function mapOffer(o: any) {
  return {
    version: o.version,
    createdBy: o.created_by,
    datesA: parseRange(o.dates_a),
    datesB: parseRange(o.dates_b),
    guestsA: o.guests_a,
    guestsB: o.guests_b,
    terms: o.terms,
    message: o.message,
    createdAt: o.created_at,
  };
}

async function notifyBoth(db: Db, ctx: Ctx, ex: ExchangeRow, n: { templateKey: string; title: string; body: string; dedupe: string }) {
  for (const userId of [ex.requester_id, ex.responder_id]) {
    await notify(db, ctx, { userId, templateKey: n.templateKey, title: n.title, body: n.body, data: { exchangeId: ex.id }, dedupeKey: `${n.dedupe}:${ex.id}` });
  }
}

async function emitEx(db: Db, ctx: Ctx, ex: { id: string }, eventType: string, payload: Record<string, unknown>) {
  await emit(db, ctx, { aggregateType: 'exchange', aggregateId: ex.id, eventType, payload: { exchangeId: ex.id, ...payload } });
}

// ---------------------------------------------------------------------------------------------
// EXCH-01 eligibility & profile & discovery
// ---------------------------------------------------------------------------------------------

export type EligibilityPredicate = 'ACCOUNT_NOT_ACTIVE' | 'IDENTITY_NOT_VERIFIED' | 'NO_EXCHANGE_HOME' | 'ACTIVE_SANCTION' | 'PROFILE_INCOMPLETE';

export interface Eligibility {
  eligible: boolean;
  unmet: EligibilityPredicate[];
  homes: Array<{ id: string; title: string; city: string | null }>;
  profile: { homeDescription: string | null; preferredDestinations: string[]; flexibleDates: boolean; status: string } | null;
}

const ACTIVE_SANCTION_SQL = `SELECT 1 FROM sanctions s WHERE s.user_id = $1 AND s.lifted_at IS NULL AND s.sanction_type <> 'WARNING'
   AND s.starts_at <= now() AND (s.ends_at IS NULL OR s.ends_at > now()) LIMIT 1`;

/** EXCH-01: evaluate every eligibility predicate and return the unmet ones. */
export async function evaluateEligibility(db: Db, userId: string): Promise<Eligibility> {
  const user = await maybeOne<{ status: string; identity_verified_at: string | null }>(db, `SELECT status, identity_verified_at FROM users WHERE id = $1`, [userId]);
  if (!user) throw notFound('User');
  const homes = await q<{ id: string; title: string; city: string | null }>(
    db,
    `SELECT id, title, city FROM properties WHERE host_id = $1 AND exchange_enabled AND status = 'PUBLISHED' ORDER BY created_at`,
    [userId],
  );
  const sanction = await maybeOne(db, ACTIVE_SANCTION_SQL, [userId]);
  const profile = await maybeOne<any>(db, `SELECT * FROM exchange_profiles WHERE user_id = $1`, [userId]);
  const unmet: EligibilityPredicate[] = [];
  if (user.status !== 'ACTIVE') unmet.push('ACCOUNT_NOT_ACTIVE');
  if (!user.identity_verified_at) unmet.push('IDENTITY_NOT_VERIFIED');
  if (homes.length === 0) unmet.push('NO_EXCHANGE_HOME');
  if (sanction) unmet.push('ACTIVE_SANCTION');
  if (!isProfileComplete(profile)) unmet.push('PROFILE_INCOMPLETE');
  return {
    eligible: unmet.length === 0,
    unmet,
    homes,
    profile: profile
      ? { homeDescription: profile.home_description, preferredDestinations: profile.preferred_destinations, flexibleDates: profile.flexible_dates, status: profile.status }
      : null,
  };
}

function isProfileComplete(p: any): boolean {
  return !!p && typeof p.home_description === 'string' && p.home_description.trim().length >= 10 && (p.preferred_destinations?.length ?? 0) >= 1;
}

export async function upsertProfile(
  db: Db,
  ctx: Ctx,
  input: { homeDescription?: string | null; preferredDestinations?: string[]; flexibleDates?: boolean },
): Promise<Eligibility> {
  const actor = requireActor(ctx);
  const dests = input.preferredDestinations ? Array.from(new Set(input.preferredDestinations.map((d) => d.trim()).filter(Boolean))) : null;
  await db.query(
    `INSERT INTO exchange_profiles(user_id, home_description, preferred_destinations, flexible_dates)
     VALUES ($1, $2, coalesce($3::text[], '{}'), coalesce($4, true))
     ON CONFLICT (user_id) DO UPDATE SET
       home_description = CASE WHEN $5 THEN EXCLUDED.home_description ELSE exchange_profiles.home_description END,
       preferred_destinations = coalesce($3::text[], exchange_profiles.preferred_destinations),
       flexible_dates = coalesce($4, exchange_profiles.flexible_dates),
       updated_at = now()`,
    [actor.userId, input.homeDescription ?? null, dests, input.flexibleDates ?? null, input.homeDescription !== undefined],
  );
  const el = await evaluateEligibility(db, actor.userId);
  const status = el.unmet.includes('ACTIVE_SANCTION') ? 'SUSPENDED' : el.eligible ? 'ELIGIBLE' : 'INCOMPLETE';
  await db.query(`UPDATE exchange_profiles SET status = $2 WHERE user_id = $1`, [actor.userId, status]);
  if (el.profile) el.profile.status = status;
  await emit(db, ctx, {
    aggregateType: 'exchange_profile',
    aggregateId: actor.userId,
    eventType: 'exchange.eligibility.updated',
    payload: { userId: actor.userId, eligible: el.eligible, unmet: el.unmet, status },
  });
  return el;
}

/** EXCH-01 discovery: exchange-enabled published homes of other verified members, date-aware, with mutual fit. */
export async function discoverHomes(
  db: Db,
  ctx: Ctx,
  f: { city?: string; start?: string; end?: string; guests?: number; limit: number },
) {
  const actor = requireActor(ctx);
  if ((f.start && !f.end) || (!f.start && f.end)) throw unprocessable('INVALID_DATE_RANGE', 'Provide both start and end');
  if (f.start && f.end) assertCalendarRange({ start: f.start, end: f.end });
  const me = await maybeOne<{ preferred_destinations: string[] }>(db, `SELECT preferred_destinations FROM exchange_profiles WHERE user_id = $1`, [actor.userId]);
  const myPrefs = new Set((me?.preferred_destinations ?? []).map((s) => s.toLowerCase()));
  const myCities = new Set(
    (await q<{ city: string | null }>(db, `SELECT city FROM properties WHERE host_id = $1 AND exchange_enabled AND status = 'PUBLISHED'`, [actor.userId]))
      .map((r) => r.city?.toLowerCase())
      .filter((c): c is string => !!c),
  );
  const rows = await q<any>(
    db,
    `SELECT p.id, p.title, p.summary, p.property_type, p.room_type, p.max_guests, p.bedrooms, p.beds, p.bathrooms,
            p.city, p.region, p.country, p.host_id, u.display_name AS host_display_name,
            coalesce(ep.preferred_destinations, '{}') AS host_prefs, ep.flexible_dates
       FROM properties p
       JOIN users u ON u.id = p.host_id
       LEFT JOIN exchange_profiles ep ON ep.user_id = p.host_id
      WHERE p.status = 'PUBLISHED' AND p.exchange_enabled AND p.host_id <> $1
        AND u.status = 'ACTIVE' AND u.identity_verified_at IS NOT NULL
        AND ($2::text IS NULL OR lower(p.city) = lower($2))
        AND ($3::int IS NULL OR p.max_guests >= $3)
      ORDER BY p.published_at DESC NULLS LAST, p.id
      LIMIT 200`,
    [actor.userId, f.city ?? null, f.guests ?? null],
  );
  const items = [];
  for (const r of rows) {
    if (f.start && f.end && !(await isRangeFree(db, r.id, f.start, f.end))) continue;
    const iWantTheirCity = !!r.city && myPrefs.has(String(r.city).toLowerCase());
    const theyWantMyCity = (r.host_prefs as string[]).some((d) => myCities.has(d.toLowerCase()));
    items.push({
      id: r.id,
      title: r.title,
      summary: r.summary,
      propertyType: r.property_type,
      roomType: r.room_type,
      maxGuests: r.max_guests,
      bedrooms: r.bedrooms,
      beds: r.beds,
      bathrooms: r.bathrooms,
      city: r.city,
      region: r.region,
      country: r.country,
      host: { id: r.host_id, displayName: r.host_display_name, preferredDestinations: r.host_prefs, flexibleDates: r.flexible_dates ?? true },
      mutualFit: { score: (iWantTheirCity ? 50 : 0) + (theyWantMyCity ? 50 : 0), iWantTheirCity, theyWantMyCity },
    });
  }
  items.sort((a, b) => b.mutualFit.score - a.mutualFit.score);
  return { items: items.slice(0, f.limit) };
}

// ---------------------------------------------------------------------------------------------
// EXCH-02 request / counter / accept / decline / withdraw / expire
// ---------------------------------------------------------------------------------------------

export interface CreateExchangeInput {
  myPropertyId: string;
  theirPropertyId: string;
  datesA: DateRange;
  datesB: DateRange;
  guestsA: number;
  guestsB: number;
  message?: string | null;
  terms?: Record<string, unknown>;
}

async function loadExchangeableProperty(db: Db, id: string) {
  return maybeOne<{ id: string; host_id: string; status: string; exchange_enabled: boolean; max_guests: number; city: string | null; title: string }>(
    db,
    `SELECT id, host_id, status, exchange_enabled, max_guests, city, title FROM properties WHERE id = $1`,
    [id],
  );
}

async function validateOfferTerms(db: Db, propA: { id: string; max_guests: number }, propB: { id: string; max_guests: number }, o: { datesA: DateRange; datesB: DateRange; guestsA: number; guestsB: number }) {
  assertFutureRange(o.datesA, 'datesA');
  assertFutureRange(o.datesB, 'datesB');
  if (o.guestsA > propA.max_guests) throw unprocessable('TOO_MANY_GUESTS', `Home A allows at most ${propA.max_guests} guests`);
  if (o.guestsB > propB.max_guests) throw unprocessable('TOO_MANY_GUESTS', `Home B allows at most ${propB.max_guests} guests`);
  if (!(await isRangeFree(db, propA.id, o.datesA.start, o.datesA.end))) throw conflict('INVENTORY_UNAVAILABLE', 'Home A is not available for datesA', { propertyId: propA.id });
  if (!(await isRangeFree(db, propB.id, o.datesB.start, o.datesB.end))) throw conflict('INVENTORY_UNAVAILABLE', 'Home B is not available for datesB', { propertyId: propB.id });
}

export async function createExchange(db: Tx, ctx: Ctx, input: CreateExchangeInput) {
  const actor = requireActor(ctx);
  await assertEnabled(db, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
  if (input.myPropertyId === input.theirPropertyId) throw unprocessable('SAME_PROPERTY', 'Choose two different homes');
  const propA = await loadExchangeableProperty(db, input.myPropertyId);
  if (!propA) throw notFound('Property');
  if (propA.host_id !== actor.userId) throw forbidden('NOT_PROPERTY_OWNER', 'myPropertyId must be your own home');
  if (!propA.exchange_enabled || propA.status !== 'PUBLISHED') throw unprocessable('PROPERTY_NOT_EXCHANGEABLE', 'Your home is not published for exchange');
  const propB = await loadExchangeableProperty(db, input.theirPropertyId);
  if (!propB || !propB.exchange_enabled || propB.status !== 'PUBLISHED') throw notFound('Exchange home');
  if (propB.host_id === actor.userId) throw unprocessable('SELF_EXCHANGE', 'You cannot exchange with yourself');

  const mine = await evaluateEligibility(db, actor.userId);
  if (!mine.eligible) throw unprocessable('NOT_ELIGIBLE', 'You are not eligible for Home Exchange yet', { unmet: mine.unmet });
  const theirs = await evaluateEligibility(db, propB.host_id);
  if (!theirs.eligible) throw unprocessable('COUNTERPARTY_NOT_ELIGIBLE', 'The other member is not currently eligible for Home Exchange');

  await validateOfferTerms(db, propA, propB, input);
  const dup = await maybeOne(
    db,
    `SELECT 1 FROM exchange_requests WHERE requester_id = $1 AND property_a_id = $2 AND property_b_id = $3 AND status IN ('REQUESTED','COUNTERED') LIMIT 1`,
    [actor.userId, propA.id, propB.id],
  );
  if (dup) throw conflict('DUPLICATE_OPEN_REQUEST', 'You already have an open exchange request for these homes');

  const ex = await one<ExchangeRow>(
    db,
    `INSERT INTO exchange_requests(requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status,
                                   current_offer_version, last_offer_by, accepted_a_version, respond_by)
     VALUES ($1,$2,$3,$4,$5::daterange,$6::daterange,'REQUESTED',1,$1,1,$7) RETURNING *`,
    [actor.userId, propB.host_id, propA.id, propB.id, rangeLiteral(input.datesA), rangeLiteral(input.datesB), addDays(OFFER_TTL_DAYS)],
  );
  await recordTransition(db, ctx, { aggregateType: 'EXCHANGE', aggregateId: ex.id, from: null, to: 'REQUESTED', reason: 'exchange requested' });
  await db.query(
    `INSERT INTO exchange_offers(exchange_id, version, created_by, dates_a, dates_b, guests_a, guests_b, terms, message)
     VALUES ($1,1,$2,$3::daterange,$4::daterange,$5,$6,$7,$8)`,
    [ex.id, actor.userId, rangeLiteral(input.datesA), rangeLiteral(input.datesB), input.guestsA, input.guestsB, JSON.stringify(input.terms ?? {}), input.message ?? null],
  );
  const conv: unknown = await ensureConversation(db, ctx, {
    contextType: 'EXCHANGE',
    contextId: ex.id,
    members: [
      { userId: ex.requester_id, role: 'REQUESTER' },
      { userId: ex.responder_id, role: 'RESPONDER' },
    ],
  });
  const conversationId = typeof conv === 'string' ? conv : (conv as { id: string }).id;
  await db.query(`UPDATE exchange_requests SET conversation_id = $2 WHERE id = $1`, [ex.id, conversationId]);
  await emitEx(db, ctx, ex, 'exchange.requested', {
    requesterId: ex.requester_id,
    responderId: ex.responder_id,
    propertyAId: ex.property_a_id,
    propertyBId: ex.property_b_id,
    datesA: input.datesA,
    datesB: input.datesB,
    offerVersion: 1,
  });
  await notify(db, ctx, {
    userId: ex.responder_id,
    templateKey: 'exchange.requested',
    title: '새 홈 익스체인지 요청',
    body: `${propA.title} ↔ ${propB.title}`,
    data: { exchangeId: ex.id },
    dedupeKey: `exchange.requested:${ex.id}`,
  });
  return getExchange(db, ctx, ex.id);
}

export async function counterExchange(
  db: Tx,
  ctx: Ctx,
  id: string,
  input: { expectedVersion: number; datesA?: DateRange; datesB?: DateRange; guestsA?: number; guestsB?: number; terms?: Record<string, unknown>; message?: string | null },
) {
  const actor = requireActor(ctx);
  await assertEnabled(db, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, NEGOTIABLE, 'COUNTERED');
  if (input.expectedVersion !== ex.current_offer_version) {
    throw conflict('OFFER_VERSION_MISMATCH', 'The offer has changed; reload and try again', { currentOfferVersion: ex.current_offer_version });
  }
  if (ex.last_offer_by === actor.userId) throw conflict('NOT_YOUR_TURN', 'Wait for the other member to respond to your offer');
  const prev = mapOffer(await currentOffer(db, ex.id, ex.current_offer_version));
  const next = {
    datesA: input.datesA ?? prev.datesA,
    datesB: input.datesB ?? prev.datesB,
    guestsA: input.guestsA ?? prev.guestsA,
    guestsB: input.guestsB ?? prev.guestsB,
    terms: input.terms ?? prev.terms,
  };
  const propA = (await loadExchangeableProperty(db, ex.property_a_id))!;
  const propB = (await loadExchangeableProperty(db, ex.property_b_id))!;
  await validateOfferTerms(db, propA, propB, next);
  const version = ex.current_offer_version + 1;
  await db.query(
    `INSERT INTO exchange_offers(exchange_id, version, created_by, dates_a, dates_b, guests_a, guests_b, terms, message)
     VALUES ($1,$2,$3,$4::daterange,$5::daterange,$6,$7,$8,$9)`,
    [ex.id, version, actor.userId, rangeLiteral(next.datesA), rangeLiteral(next.datesB), next.guestsA, next.guestsB, JSON.stringify(next.terms ?? {}), input.message ?? null],
  );
  await exchangeFsm.transition(db, ctx, {
    table: 'exchange_requests',
    id: ex.id,
    from: NEGOTIABLE,
    to: 'COUNTERED',
    reason: `counter offer v${version}`,
    versioned: true,
    metadata: { offerVersion: version },
    set: {
      current_offer_version: version,
      last_offer_by: actor.userId,
      dates_a: rangeLiteral(next.datesA),
      dates_b: rangeLiteral(next.datesB),
      [party === 'A' ? 'accepted_a_version' : 'accepted_b_version']: version,
      respond_by: addDays(OFFER_TTL_DAYS),
    },
  });
  await emitEx(db, ctx, ex, 'exchange.countered', { offerVersion: version, by: actor.userId, datesA: next.datesA, datesB: next.datesB });
  await notify(db, ctx, {
    userId: otherUser(ex, party!),
    templateKey: 'exchange.countered',
    title: '홈 익스체인지 수정 제안',
    body: `새 제안(v${version})이 도착했습니다.`,
    data: { exchangeId: ex.id, offerVersion: version },
    dedupeKey: `exchange.countered:${ex.id}:${version}`,
  });
  return getExchange(db, ctx, ex.id);
}

export async function acceptExchange(db: Tx, ctx: Ctx, id: string, input: { offerVersion: number }) {
  const actor = requireActor(ctx);
  await assertEnabled(db, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, NEGOTIABLE, 'MUTUAL_ACCEPTED');
  if (input.offerVersion !== ex.current_offer_version) {
    throw conflict('OFFER_VERSION_MISMATCH', 'Only the current offer version can be accepted', { currentOfferVersion: ex.current_offer_version });
  }
  const acceptedA = party === 'A' ? input.offerVersion : ex.accepted_a_version;
  const acceptedB = party === 'B' ? input.offerVersion : ex.accepted_b_version;
  if (acceptedA !== ex.current_offer_version || acceptedB !== ex.current_offer_version) {
    // Only possible for the maker of the latest offer, who has implicitly accepted it already.
    await db.query(`UPDATE exchange_requests SET accepted_a_version = $2, accepted_b_version = $3 WHERE id = $1`, [ex.id, acceptedA, acceptedB]);
    return getExchange(db, ctx, ex.id);
  }
  const offer = mapOffer(await currentOffer(db, ex.id, ex.current_offer_version));
  if (!(await isRangeFree(db, ex.property_a_id, offer.datesA.start, offer.datesA.end)) || !(await isRangeFree(db, ex.property_b_id, offer.datesB.start, offer.datesB.end))) {
    throw conflict('INVENTORY_UNAVAILABLE', 'One of the homes is no longer available for these dates');
  }
  await exchangeFsm.transition(db, ctx, {
    table: 'exchange_requests',
    id: ex.id,
    from: NEGOTIABLE,
    to: 'MUTUAL_ACCEPTED',
    reason: `both parties accepted offer v${ex.current_offer_version}`,
    versioned: true,
    metadata: { offerVersion: ex.current_offer_version },
    set: { accepted_a_version: acceptedA, accepted_b_version: acceptedB, respond_by: null },
  });
  await emitEx(db, ctx, ex, 'exchange.accepted', { offerVersion: ex.current_offer_version, by: actor.userId });
  await emitEx(db, ctx, ex, 'exchange.mutual_accepted', { offerVersion: ex.current_offer_version });
  await exchangeFsm.transition(db, ctx, {
    table: 'exchange_requests',
    id: ex.id,
    from: 'MUTUAL_ACCEPTED',
    to: 'VERIFICATION_PENDING',
    reason: 'verification gate opened',
    versioned: true,
    actorType: 'SYSTEM',
  });
  for (const userId of [ex.requester_id, ex.responder_id]) {
    for (const checkType of ['IDENTITY', 'PROPERTY', 'SAFETY_ACK']) {
      await db.query(
        `INSERT INTO exchange_verifications(exchange_id, party_user_id, check_type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [ex.id, userId, checkType],
      );
    }
  }
  await emitEx(db, ctx, ex, 'exchange.verification_pending', { offerVersion: ex.current_offer_version });
  await notifyBoth(db, ctx, ex, { templateKey: 'exchange.verification_pending', title: '익스체인지 상호 수락 완료', body: '안전 확인 및 인증 절차를 진행해 주세요.', dedupe: 'exchange.verification_pending' });
  return getExchange(db, ctx, ex.id);
}

export async function declineExchange(db: Tx, ctx: Ctx, id: string, input: { reason?: string | null }) {
  const actor = requireActor(ctx);
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, NEGOTIABLE, 'DECLINED');
  if (ex.last_offer_by === actor.userId) throw conflict('CANNOT_DECLINE_OWN_OFFER', 'Withdraw your own offer instead');
  await exchangeFsm.transition(db, ctx, { table: 'exchange_requests', id, from: NEGOTIABLE, to: 'DECLINED', reason: input.reason ?? 'declined', versioned: true, set: { respond_by: null } });
  await emitEx(db, ctx, ex, 'exchange.declined', { by: actor.userId, reason: input.reason ?? null });
  await notify(db, ctx, { userId: otherUser(ex, party!), templateKey: 'exchange.declined', title: '익스체인지 요청 거절', body: '상대방이 요청을 거절했습니다.', data: { exchangeId: id }, dedupeKey: `exchange.declined:${id}` });
  return getExchange(db, ctx, id);
}

export async function withdrawExchange(db: Tx, ctx: Ctx, id: string, input: { reason?: string | null }) {
  const actor = requireActor(ctx);
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, NEGOTIABLE, 'WITHDRAWN');
  await exchangeFsm.transition(db, ctx, { table: 'exchange_requests', id, from: NEGOTIABLE, to: 'WITHDRAWN', reason: input.reason ?? 'withdrawn', versioned: true, set: { respond_by: null } });
  await emitEx(db, ctx, ex, 'exchange.withdrawn', { by: actor.userId, reason: input.reason ?? null });
  await notify(db, ctx, { userId: otherUser(ex, party!), templateKey: 'exchange.withdrawn', title: '익스체인지 요청 철회', body: '상대방이 요청을 철회했습니다.', data: { exchangeId: id }, dedupeKey: `exchange.withdrawn:${id}` });
  return getExchange(db, ctx, id);
}

// ---------------------------------------------------------------------------------------------
// EXCH-03 verification gate
// ---------------------------------------------------------------------------------------------

async function runChecks(db: Db, ex: ExchangeRow) {
  const parties = [
    { userId: ex.requester_id, propertyId: ex.property_a_id },
    { userId: ex.responder_id, propertyId: ex.property_b_id },
  ];
  for (const p of parties) {
    const u = await one<{ status: string; identity_verified_at: string | null }>(db, `SELECT status, identity_verified_at FROM users WHERE id = $1`, [p.userId]);
    const sanctioned = !!(await maybeOne(db, ACTIVE_SANCTION_SQL, [p.userId]));
    const idFailures = [
      ...(u.identity_verified_at ? [] : ['IDENTITY_NOT_VERIFIED']),
      ...(u.status === 'ACTIVE' ? [] : ['ACCOUNT_NOT_ACTIVE']),
      ...(sanctioned ? ['ACTIVE_SANCTION'] : []),
    ];
    await setCheck(db, ex.id, p.userId, 'IDENTITY', idFailures.length === 0 ? 'PASSED' : 'FAILED', { failures: idFailures });

    const prop = await maybeOne<{ host_id: string; status: string; exchange_enabled: boolean }>(db, `SELECT host_id, status, exchange_enabled FROM properties WHERE id = $1`, [p.propertyId]);
    const openReports = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM safety_reports WHERE subject_type = 'PROPERTY' AND subject_id = $1 AND status IN ('OPEN','TRIAGED')`,
      [p.propertyId],
    );
    const propFailures = [
      ...(prop && prop.host_id === p.userId ? [] : ['NOT_OWNER']),
      ...(prop?.status === 'PUBLISHED' ? [] : ['NOT_PUBLISHED']),
      ...(prop?.exchange_enabled ? [] : ['EXCHANGE_DISABLED']),
      ...(openReports.n > 0 ? ['OPEN_SAFETY_REPORT'] : []),
    ];
    await setCheck(db, ex.id, p.userId, 'PROPERTY', propFailures.length === 0 ? 'PASSED' : 'FAILED', { propertyId: p.propertyId, failures: propFailures });
  }
  return q<any>(db, `SELECT party_user_id, check_type, status, detail, checked_at FROM exchange_verifications WHERE exchange_id = $1 ORDER BY party_user_id, check_type`, [ex.id]);
}

async function setCheck(db: Db, exchangeId: string, userId: string, checkType: string, status: 'PASSED' | 'FAILED', detail: Record<string, unknown>) {
  await db.query(
    `INSERT INTO exchange_verifications(exchange_id, party_user_id, check_type, status, detail, checked_at) VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (exchange_id, party_user_id, check_type) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = now()`,
    [exchangeId, userId, checkType, status, JSON.stringify(detail)],
  );
}

/** EXCH-03: run IDENTITY + PROPERTY checks for both parties; when all checks (incl. SAFETY_ACK) pass → AGREEMENT_PENDING. */
export async function runVerification(db: Tx, ctx: Ctx, id: string) {
  if (ctx.actor) await assertEnabled(db, EXCHANGE_FLAG, { userId: ctx.actor.userId, roles: ctx.actor.roles });
  const { ex } = await lockForParty(db, ctx, id, { allowSystem: true });
  assertStatus(ex, ['VERIFICATION_PENDING'], 'AGREEMENT_PENDING');
  const checks = await runChecks(db, ex);
  const allPassed = checks.length === 6 && checks.every((c) => c.status === 'PASSED');
  if (allPassed) {
    await emitEx(db, ctx, ex, 'exchange.verified', { offerVersion: ex.current_offer_version });
    await exchangeFsm.transition(db, ctx, {
      table: 'exchange_requests',
      id,
      from: 'VERIFICATION_PENDING',
      to: 'AGREEMENT_PENDING',
      reason: 'all verification checks passed',
      versioned: true,
    });
    const agreement = await createAgreement(db, ctx, ex);
    await emitEx(db, ctx, ex, 'exchange.agreement.created', { agreementId: agreement.id, termsVersion: agreement.terms_version, termsHash: agreement.terms_hash, offerVersion: agreement.offer_version });
    await notifyBoth(db, ctx, ex, { templateKey: 'exchange.agreement.created', title: '익스체인지 약정서 준비 완료', body: '약정서를 확인하고 서명해 주세요.', dedupe: 'exchange.agreement.created' });
  }
  return { ...(await getExchange(db, ctx, id)), checks: checks.map(checkMapper(ctx.actor?.userId ?? null, !ctx.actor)) };
}

/**
 * Failure codes a member may see on their OWN checks. Trust & safety internals are generalized: an open safety report
 * against the member's home is shown as PROPERTY_UNDER_REVIEW (never "a report was filed").
 */
const SELF_VISIBLE_FAILURES: Record<string, string> = {
  IDENTITY_NOT_VERIFIED: 'IDENTITY_NOT_VERIFIED',
  ACCOUNT_NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',
  ACTIVE_SANCTION: 'ACTIVE_SANCTION', // the member was notified of the sanction and sees it in EXCH-01 eligibility
  NOT_OWNER: 'NOT_OWNER',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  EXCHANGE_DISABLED: 'EXCHANGE_DISABLED',
  OPEN_SAFETY_REPORT: 'PROPERTY_UNDER_REVIEW',
};

/**
 * Viewer-aware verification rows. The counterparty's rows carry only their status (never the other member's failure
 * reasons, sanctions, safety reports or acknowledgement evidence); the viewer's own rows carry the actionable failure
 * codes; staff (audited) and the system see the full detail.
 */
function checkMapper(viewerId: string | null, full: boolean) {
  return (c: any) => {
    const base = { partyUserId: c.party_user_id, checkType: c.check_type, status: c.status, checkedAt: c.checked_at };
    if (full) return { ...base, detail: c.detail };
    if (c.party_user_id !== viewerId) return base;
    const failures = Array.isArray(c.detail?.failures)
      ? Array.from(new Set((c.detail.failures as string[]).map((f) => SELF_VISIBLE_FAILURES[f] ?? 'CHECK_FAILED')))
      : undefined;
    const detail: Record<string, unknown> = {};
    if (failures) detail.failures = failures;
    if (c.detail?.propertyId) detail.propertyId = c.detail.propertyId;
    if (c.detail?.acknowledgedAt) detail.acknowledgedAt = c.detail.acknowledgedAt;
    return { ...base, detail };
  };
}

export async function acknowledgeSafety(db: Tx, ctx: Ctx, id: string) {
  const actor = requireActor(ctx);
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, ['VERIFICATION_PENDING']);
  const acknowledgedAt = new Date().toISOString();
  // the check row holds no personal data (it is shown to the counterparty); the acknowledgement evidence (actor,
  // session, correlation id, ip, user agent) lives in the append-only audit log
  await setCheck(db, ex.id, actor.userId, 'SAFETY_ACK', 'PASSED', { acknowledgedAt });
  await audit(db, ctx, {
    action: 'exchange.safety_acknowledged', resourceType: 'exchange', resourceId: ex.id,
    after: { party: party === 'A' ? 'REQUESTER' : 'RESPONDER', acknowledgedAt, sessionId: actor.sessionId }, category: 'COMPLIANCE',
  });
  return runVerification(db, ctx, id);
}

// ---------------------------------------------------------------------------------------------
// EXCH-04 agreement & e-consent
// ---------------------------------------------------------------------------------------------

async function createAgreement(db: Db, ctx: Ctx, ex: ExchangeRow) {
  const offer = mapOffer(await currentOffer(db, ex.id, ex.current_offer_version));
  const terms = await maybeOne<{ version: string; title: string; body_md: string }>(
    db,
    `SELECT version, title, body_md FROM consent_documents WHERE consent_type = 'EXCHANGE_TERMS'
      ORDER BY published_at DESC NULLS LAST, version DESC LIMIT 1`,
  );
  if (!terms) throw conflict('TERMS_UNAVAILABLE', 'Platform exchange terms are not configured');
  const rules = async (propertyId: string) =>
    maybeOne<any>(db, `SELECT smoking_allowed, pets_allowed, events_allowed, quiet_hours, extra_rules FROM house_rules WHERE property_id = $1`, [propertyId]);
  const props = await q<any>(db, `SELECT id, title, check_in_time::text AS check_in_time, check_out_time::text AS check_out_time FROM properties WHERE id = ANY($1::uuid[])`, [[ex.property_a_id, ex.property_b_id]]);
  const pa = props.find((p) => p.id === ex.property_a_id);
  const pb = props.find((p) => p.id === ex.property_b_id);
  const snapshot = {
    schema: 'jetpool.exchange.agreement/v1',
    exchangeId: ex.id,
    offerVersion: offer.version,
    offer: { datesA: offer.datesA, datesB: offer.datesB, guestsA: offer.guestsA, guestsB: offer.guestsB, terms: offer.terms, createdBy: offer.createdBy },
    parties: {
      requester: { userId: ex.requester_id, propertyId: ex.property_a_id },
      responder: { userId: ex.responder_id, propertyId: ex.property_b_id },
    },
    homes: {
      A: { propertyId: ex.property_a_id, title: pa?.title ?? null, checkInTime: pa?.check_in_time ?? null, checkOutTime: pa?.check_out_time ?? null, houseRules: await rules(ex.property_a_id) },
      B: { propertyId: ex.property_b_id, title: pb?.title ?? null, checkInTime: pb?.check_in_time ?? null, checkOutTime: pb?.check_out_time ?? null, houseRules: await rules(ex.property_b_id) },
    },
    platformTerms: { type: 'EXCHANGE_TERMS', version: terms.version, title: terms.title, bodySha256: sha256(terms.body_md) },
  };
  const termsHash = sha256(canonicalJson(snapshot));
  return one<any>(
    db,
    `INSERT INTO exchange_agreements(exchange_id, terms_version, terms_snapshot, terms_hash, offer_version) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ex.id, terms.version, JSON.stringify(snapshot), termsHash, offer.version],
  );
}

function mapAgreement(a: any, opts: { evidence: boolean }) {
  if (!a) return null;
  return {
    id: a.id,
    status: a.status,
    termsVersion: a.terms_version,
    termsHash: a.terms_hash,
    offerVersion: a.offer_version,
    termsSnapshot: a.terms_snapshot,
    signatures: {
      requester: a.accepted_a_at ? { signedAt: a.accepted_a_at, ...(opts.evidence ? { evidence: a.accepted_a_evidence } : {}) } : null,
      responder: a.accepted_b_at ? { signedAt: a.accepted_b_at, ...(opts.evidence ? { evidence: a.accepted_b_evidence } : {}) } : null,
    },
    createdAt: a.created_at,
  };
}

export async function getAgreement(db: Db, ctx: Ctx, id: string) {
  const actor = requireActor(ctx);
  const ex = await maybeOne<ExchangeRow>(db, `SELECT * FROM exchange_requests WHERE id = $1`, [id]);
  const staff = canStaffRead(ctx);
  if (!ex || (!partyOf(ex, actor.userId) && !staff)) throw notFound('Exchange');
  const a = await maybeOne(db, `SELECT * FROM exchange_agreements WHERE exchange_id = $1`, [id]);
  if (!a) throw notFound('Agreement');
  if (staff && !partyOf(ex, actor.userId)) {
    await audit(db, ctx, { action: 'exchange.agreement.read', resourceType: 'exchange_agreement', resourceId: a.id, category: 'ELEVATED_ACCESS' });
  }
  return { item: mapAgreement(a, { evidence: staff }) };
}

/** EXCH-04: sign the exact terms hash. Evidence is write-once. Second signature auto-confirms (EXCH-05). */
export async function signAgreement(db: Tx, ctx: Ctx, id: string, input: { termsHash: string }) {
  const actor = requireActor(ctx);
  await assertEnabled(db, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, ['AGREEMENT_PENDING']);
  const a = await maybeOne<any>(db, `SELECT * FROM exchange_agreements WHERE exchange_id = $1 FOR UPDATE`, [id]);
  if (!a) throw notFound('Agreement');
  if (!['PENDING', 'PARTIALLY_SIGNED'].includes(a.status)) throw conflict('AGREEMENT_NOT_SIGNABLE', `Agreement is ${a.status}`);
  if (a.offer_version !== ex.current_offer_version) throw conflict('AGREEMENT_STALE', 'Agreement does not match the current offer');
  if (input.termsHash !== a.terms_hash) throw conflict('TERMS_HASH_MISMATCH', 'You must sign the current agreement terms', { termsHash: a.terms_hash, termsVersion: a.terms_version });
  const col = party === 'A' ? 'a' : 'b';
  if (a[`accepted_${col}_at`]) throw conflict('ALREADY_SIGNED', 'You have already signed this agreement');
  const evidence = {
    termsHash: a.terms_hash,
    termsVersion: a.terms_version,
    offerVersion: a.offer_version,
    signedAt: new Date().toISOString(),
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    sessionId: actor.sessionId,
    correlationId: ctx.correlationId,
  };
  const otherSigned = !!a[`accepted_${col === 'a' ? 'b' : 'a'}_at`];
  const status = otherSigned ? 'SIGNED' : 'PARTIALLY_SIGNED';
  // write-once: the column guard prevents a concurrent duplicate from overwriting evidence
  const upd = await db.query(
    `UPDATE exchange_agreements SET accepted_${col}_at = now(), accepted_${col}_evidence = $2, status = $3
      WHERE id = $1 AND accepted_${col}_at IS NULL`,
    [a.id, JSON.stringify(evidence), status],
  );
  if (upd.rowCount !== 1) throw conflict('ALREADY_SIGNED', 'You have already signed this agreement');
  // legal e-consent is a compliance mutation: append-only audit row in the same tx (actor, correlation id, ip, UA)
  await audit(db, ctx, {
    action: 'exchange.agreement.signed',
    resourceType: 'exchange_agreement',
    resourceId: a.id,
    before: { status: a.status },
    after: { status, party: party === 'A' ? 'REQUESTER' : 'RESPONDER', exchangeId: ex.id, termsHash: a.terms_hash, termsVersion: a.terms_version, offerVersion: a.offer_version },
    category: 'COMPLIANCE',
  });
  await emitEx(db, ctx, ex, 'exchange.agreement.signed', { agreementId: a.id, by: actor.userId, termsHash: a.terms_hash, termsVersion: a.terms_version, fullySigned: otherSigned });
  let autoConfirm: { confirmed: boolean; error?: string } | undefined;
  if (otherSigned) {
    try {
      await confirmExchange(db, ctx, id);
      autoConfirm = { confirmed: true };
    } catch (err) {
      // inventory conflicts leave the agreement SIGNED; parties may retry POST /confirm after resolving
      if (err instanceof AppError && err.status === 409) autoConfirm = { confirmed: false, error: err.code };
      else throw err;
    }
  }
  return { ...(await getExchange(db, ctx, id)), autoConfirm };
}

// ---------------------------------------------------------------------------------------------
// EXCH-05 calendar lock (confirm) & cancellation
// ---------------------------------------------------------------------------------------------

/**
 * EXCH-05: atomically block BOTH homes and move to CONFIRMED. Must run inside the caller's tx.
 * Both acquisitions sit behind one savepoint: if either fails, neither block remains (invariant 6).
 * Callable by a party or the system (ctx.actor null). Already-confirmed exchanges are returned unchanged.
 */
export async function confirmExchange(db: Tx, ctx: Ctx, exchangeId: string) {
  const { ex } = await lockForParty(db, ctx, exchangeId, { allowSystem: true });
  if (['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(ex.status)) {
    return { ...(await getExchange(db, ctx, exchangeId)), alreadyConfirmed: true };
  }
  assertStatus(ex, ['AGREEMENT_PENDING'], 'CONFIRMED');
  const a = await maybeOne<any>(db, `SELECT * FROM exchange_agreements WHERE exchange_id = $1 FOR UPDATE`, [exchangeId]);
  if (!a || a.status !== 'SIGNED') throw conflict('AGREEMENT_NOT_SIGNED', 'Both parties must sign the agreement before confirmation');
  if (a.offer_version !== ex.current_offer_version) throw conflict('AGREEMENT_STALE', 'Agreement does not match the current offer');
  const offer = mapOffer(await currentOffer(db, ex.id, ex.current_offer_version));
  const wanted = [
    { propertyId: ex.property_a_id, ...offer.datesA, side: 'A' as const },
    { propertyId: ex.property_b_id, ...offer.datesB, side: 'B' as const },
  ].sort((x, y) => (x.propertyId < y.propertyId ? -1 : 1)); // stable lock order avoids deadlocks
  const blocks: Array<{ side: Party; blockId: string; propertyId: string; start: string; end: string }> = [];
  await db.query('SAVEPOINT exchange_calendar_lock');
  try {
    for (const w of wanted) {
      const b = await acquireBlock(db, {
        propertyId: w.propertyId,
        start: w.start,
        end: w.end,
        blockType: 'EXCHANGE',
        sourceType: 'EXCHANGE',
        sourceId: ex.id,
        expiresAt: null,
        createdBy: ctx.actor?.userId ?? null,
        note: `exchange ${ex.id} home ${w.side}`,
      });
      blocks.push({ side: w.side, blockId: b.id, propertyId: w.propertyId, start: w.start, end: w.end });
    }
    await db.query('RELEASE SAVEPOINT exchange_calendar_lock');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT exchange_calendar_lock');
    throw err;
  }
  await exchangeFsm.transition(db, ctx, {
    table: 'exchange_requests',
    id: ex.id,
    from: 'AGREEMENT_PENDING',
    to: 'CONFIRMED',
    reason: 'both homes blocked atomically',
    versioned: true,
    actorType: ctx.actor ? 'USER' : 'SYSTEM',
    metadata: { blockIds: blocks.map((b) => b.blockId), agreementId: a.id },
    set: { confirmed_at: new Date() },
  });
  await emitEx(db, ctx, ex, 'exchange.calendar_blocked', { blocks });
  await emitEx(db, ctx, ex, 'exchange.confirmed', {
    requesterId: ex.requester_id,
    responderId: ex.responder_id,
    propertyAId: ex.property_a_id,
    propertyBId: ex.property_b_id,
    datesA: offer.datesA,
    datesB: offer.datesB,
    agreementId: a.id,
    termsHash: a.terms_hash,
  });
  await notifyBoth(db, ctx, ex, { templateKey: 'exchange.confirmed', title: '홈 익스체인지 확정', body: '양쪽 숙소 일정이 확정되었습니다.', dedupe: 'exchange.confirmed' });
  return getExchange(db, ctx, ex.id);
}

/** Cancel: pre-confirmed → CANCELLED (agreement VOID); CONFIRMED → release BOTH blocks in this tx, then CANCELLED. */
export async function cancelExchange(db: Tx, ctx: Ctx, id: string, input: { reason: string }) {
  const actor = requireActor(ctx);
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, [...PRE_CONFIRMED, 'CONFIRMED'], 'CANCELLED');
  const offer = mapOffer(await currentOffer(db, ex.id, ex.current_offer_version));
  const earliestStart = minDate(offer.datesA.start, offer.datesB.start);
  let releasedBlockIds: string[] = [];
  let policy: 'PRE_CONFIRMATION' | 'STANDARD' | 'LATE' = 'PRE_CONFIRMATION';
  if (ex.status === 'CONFIRMED') {
    if (earliestStart <= todayUtc()) throw conflict('EXCHANGE_STARTED', 'The exchange has started; open a dispute instead');
    policy = daysBetween(todayUtc(), earliestStart) >= LATE_CANCEL_DAYS ? 'STANDARD' : 'LATE';
    const blocks = await q<{ id: string }>(
      db,
      `SELECT id FROM inventory_blocks WHERE source_type = 'EXCHANGE' AND source_id = $1 AND state = 'ACTIVE' FOR UPDATE`,
      [ex.id],
    );
    for (const b of blocks) await releaseBlock(db, b.id);
    releasedBlockIds = blocks.map((b) => b.id);
  }
  await exchangeFsm.transition(db, ctx, {
    table: 'exchange_requests',
    id,
    to: 'CANCELLED',
    from: [...PRE_CONFIRMED, 'CONFIRMED'],
    reason: input.reason,
    versioned: true,
    metadata: { policy, releasedBlockIds, cancelledBy: actor.userId },
    set: { cancelled_at: new Date(), respond_by: null },
  });
  await db.query(`UPDATE exchange_agreements SET status = 'VOID' WHERE exchange_id = $1 AND status <> 'VOID'`, [id]);
  if (ex.status === 'CONFIRMED') {
    await audit(db, ctx, { action: 'exchange.cancelled_after_confirm', resourceType: 'exchange', resourceId: id, before: { status: ex.status }, after: { status: 'CANCELLED', policy, releasedBlockIds }, reason: input.reason });
  }
  await emitEx(db, ctx, ex, 'exchange.cancelled', { by: actor.userId, fromStatus: ex.status, policy, releasedBlockIds, reason: input.reason });
  await notify(db, ctx, { userId: otherUser(ex, party!), templateKey: 'exchange.cancelled', title: '홈 익스체인지 취소', body: '상대방이 익스체인지를 취소했습니다.', data: { exchangeId: id, policy }, dedupeKey: `exchange.cancelled:${id}` });
  return getExchange(db, ctx, id);
}

// ---------------------------------------------------------------------------------------------
// EXCH-06 lifecycle: start / complete / review / dispute
// ---------------------------------------------------------------------------------------------

async function startExchange(db: Tx, ctx: Ctx, ex: ExchangeRow) {
  await exchangeFsm.transition(db, ctx, { table: 'exchange_requests', id: ex.id, from: 'CONFIRMED', to: 'IN_PROGRESS', reason: 'earliest stay started', versioned: true, actorType: ctx.actor ? 'USER' : 'SYSTEM', set: { started_at: new Date() } });
  await emitEx(db, ctx, ex, 'exchange.started', {});
}

async function finishExchange(db: Tx, ctx: Ctx, ex: ExchangeRow, reason: string) {
  await exchangeFsm.transition(db, ctx, { table: 'exchange_requests', id: ex.id, from: 'IN_PROGRESS', to: 'COMPLETED', reason, versioned: true, actorType: ctx.actor ? 'USER' : 'SYSTEM', set: { completed_at: new Date() } });
  await emitEx(db, ctx, ex, 'exchange.completed', { requesterId: ex.requester_id, responderId: ex.responder_id, propertyAId: ex.property_a_id, propertyBId: ex.property_b_id });
  await notifyBoth(db, ctx, ex, { templateKey: 'exchange.completed', title: '홈 익스체인지 완료', body: '서로에 대한 후기를 남겨 주세요.', dedupe: 'exchange.completed' });
}

export async function completeExchange(db: Tx, ctx: Ctx, id: string) {
  requireActor(ctx);
  const { ex } = await lockForParty(db, ctx, id);
  assertStatus(ex, ['CONFIRMED', 'IN_PROGRESS'], 'COMPLETED');
  const a = parseRange(ex.dates_a), b = parseRange(ex.dates_b);
  if (todayUtc() < maxDate(a.end, b.end)) throw conflict('EXCHANGE_NOT_ENDED', 'An exchange can be completed only after both stays have ended');
  if (ex.status === 'CONFIRMED') await startExchange(db, ctx, ex);
  await finishExchange(db, ctx, ex, 'completed by party');
  return getExchange(db, ctx, id);
}

/** Contract for the reviews module (also driven by outbox `exchange.reviews.completed`). COMPLETED → REVIEWED; idempotent. */
export async function markExchangeReviewed(db: Db, ctx: Ctx, exchangeId: string): Promise<{ changed: boolean; status: string }> {
  const ex = await maybeOne<ExchangeRow>(db, `SELECT * FROM exchange_requests WHERE id = $1 FOR UPDATE`, [exchangeId]);
  if (!ex) throw notFound('Exchange');
  if (ex.status !== 'COMPLETED') return { changed: false, status: ex.status };
  await exchangeFsm.transition(db, ctx, { table: 'exchange_requests', id: exchangeId, from: 'COMPLETED', to: 'REVIEWED', reason: 'bilateral reviews completed', versioned: true, actorType: 'SYSTEM' });
  await emitEx(db, ctx, ex, 'exchange.reviewed', {});
  return { changed: true, status: 'REVIEWED' };
}

export async function disputeExchange(db: Tx, ctx: Ctx, id: string, input: { reason: string; description?: string | null; severity?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' }) {
  const actor = requireActor(ctx);
  const { ex, party } = await lockForParty(db, ctx, id);
  assertStatus(ex, ['CONFIRMED', 'IN_PROGRESS'], 'DISPUTED');
  // TRUST-03 owns the dispute record (party check, duplicate guard, severity policy, evidence, dispute.opened event,
  // audit, counterparty notification). Exchange only drives its own FSM inside the same transaction.
  let d: { id: string };
  try {
    d = await openDispute(db, ctx, {
      contextType: 'EXCHANGE',
      contextId: id,
      reason: input.reason,
      description: input.description ?? undefined,
      severity: input.severity,
      counterpartyId: otherUser(ex, party!),
    });
  } catch (err) {
    // The party already has an open TRUST-03 dispute for this exchange (opened via /v1/disputes, which does not
    // touch the exchange): freeze the exchange against that dispute instead of failing or duplicating it.
    // The guard throws before any write, so the transaction is still usable.
    const existing = err instanceof AppError && err.code === 'DISPUTE_ALREADY_OPEN' ? (err.details as { disputeId?: string } | undefined)?.disputeId : undefined;
    if (!existing) throw err;
    d = { id: existing };
  }
  await exchangeFsm.transition(db, ctx, { table: 'exchange_requests', id, from: ['CONFIRMED', 'IN_PROGRESS'], to: 'DISPUTED', reason: input.reason, versioned: true, metadata: { disputeId: d.id } });
  await emitEx(db, ctx, ex, 'exchange.disputed', { disputeId: d.id, by: actor.userId, fromStatus: ex.status });
  await notify(db, ctx, { userId: otherUser(ex, party!), templateKey: 'exchange.disputed', title: '익스체인지 분쟁 접수', body: '상대방이 분쟁을 접수했습니다.', data: { exchangeId: id, disputeId: d.id }, dedupeKey: `exchange.disputed:${id}` });
  return { ...(await getExchange(db, ctx, id)), disputeId: d.id };
}

export interface DisputeResolvedPayload {
  disputeId: string;
  outcome: 'RESOLVED' | 'REJECTED' | string;
  contextType: string;
  contextId: string;
  detail?: Record<string, unknown> | null;
}

/**
 * TRUST-03 → EXCH-06 (outbox `dispute.resolved`): a closed dispute lifts the DISPUTED freeze once no other dispute on
 * the exchange is still open. Target state:
 *  - `detail.exchangeOutcome` ('CANCELLED' | 'COMPLETED') when the resolving staff member set one;
 *  - otherwise, both stays over → COMPLETED;
 *  - otherwise a REJECTED dispute restores the pre-dispute state (CONFIRMED / IN_PROGRESS: a party who wants out must
 *    cancel under the normal policy) and an upheld (RESOLVED) one cancels the exchange.
 * CANCELLED releases, in the same tx, every EXCHANGE block whose stay has not ended (both calendars sellable again);
 * COMPLETED releases blocks whose stay never started. Idempotent (a non-DISPUTED exchange is left untouched).
 */
export async function applyDisputeResolution(db: Tx, ctx: Ctx, p: DisputeResolvedPayload): Promise<{ changed: boolean; status?: string; releasedBlockIds?: string[] }> {
  if (p.contextType !== 'EXCHANGE' || !p.contextId) return { changed: false };
  const ex = await maybeOne<ExchangeRow>(db, `SELECT * FROM exchange_requests WHERE id = $1 FOR UPDATE`, [p.contextId]);
  if (!ex || ex.status !== 'DISPUTED') return { changed: false, status: ex?.status };
  const stillOpen = await maybeOne(
    db,
    `SELECT 1 FROM disputes WHERE context_type = 'EXCHANGE' AND context_id = $1 AND id <> $2 AND status NOT IN ('RESOLVED','REJECTED') LIMIT 1`,
    [ex.id, p.disputeId],
  );
  if (stillOpen) return { changed: false, status: ex.status };
  const prev = await maybeOne<{ from_state: ExchangeStatus | null }>(
    db,
    `SELECT from_state FROM state_transitions WHERE aggregate_type = 'EXCHANGE' AND aggregate_id = $1 AND to_state = 'DISPUTED' ORDER BY id DESC LIMIT 1`,
    [ex.id],
  );
  const a = parseRange(ex.dates_a), b = parseRange(ex.dates_b);
  const today = todayUtc();
  const ended = today >= maxDate(a.end, b.end);
  const requested = p.detail?.exchangeOutcome;
  let to: ExchangeStatus;
  if (requested === 'CANCELLED' || requested === 'COMPLETED') to = requested;
  else if (ended) to = 'COMPLETED';
  else if (p.outcome === 'REJECTED') to = prev?.from_state === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'CONFIRMED';
  else to = 'CANCELLED';

  // CANCELLED: free every night that is not over yet; COMPLETED: free only stays that never began
  const blocks = await q<{ id: string }>(
    db,
    `SELECT id FROM inventory_blocks WHERE source_type = 'EXCHANGE' AND source_id = $1 AND state = 'ACTIVE'
        AND CASE WHEN $2 THEN upper(stay_range) > $3::date ELSE lower(stay_range) > $3::date END FOR UPDATE`,
    [ex.id, to === 'CANCELLED', today],
  );
  const releasedBlockIds = to === 'CANCELLED' || to === 'COMPLETED' ? blocks.map((x) => x.id) : [];
  for (const id of releasedBlockIds) await releaseBlock(db, id);
  const set: Record<string, unknown> = {};
  if (to === 'CANCELLED') set.cancelled_at = new Date();
  if (to === 'COMPLETED') set.completed_at = new Date();
  await exchangeFsm.transition(db, ctx, {
    table: 'exchange_requests', id: ex.id, from: 'DISPUTED', to, reason: `dispute ${p.outcome.toLowerCase()}`, actorType: 'SYSTEM', versioned: true,
    metadata: { disputeId: p.disputeId, outcome: p.outcome, releasedBlockIds }, set,
  });
  if (to === 'CANCELLED') await db.query(`UPDATE exchange_agreements SET status = 'VOID' WHERE exchange_id = $1 AND status <> 'VOID'`, [ex.id]);
  await emitEx(db, ctx, ex, 'exchange.dispute_resolved', { disputeId: p.disputeId, outcome: p.outcome, status: to, releasedBlockIds });
  if (to === 'CANCELLED') await emitEx(db, ctx, ex, 'exchange.cancelled', { by: null, fromStatus: 'DISPUTED', policy: 'DISPUTE_RESOLUTION', releasedBlockIds, reason: `dispute ${p.disputeId}` });
  if (to === 'COMPLETED') {
    await emitEx(db, ctx, ex, 'exchange.completed', { requesterId: ex.requester_id, responderId: ex.responder_id, propertyAId: ex.property_a_id, propertyBId: ex.property_b_id });
  }
  for (const propertyId of [ex.property_a_id, ex.property_b_id]) {
    if (releasedBlockIds.length) {
      await emit(db, ctx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'availability.changed', payload: { propertyId, reason: 'EXCHANGE_DISPUTE_RESOLVED', exchangeId: ex.id } });
    }
  }
  await notifyBoth(db, ctx, ex, {
    templateKey: 'exchange.dispute_resolved', title: '익스체인지 분쟁 처리 완료', body: `분쟁 처리 결과에 따라 익스체인지가 ${to} 상태가 되었습니다.`, dedupe: `exchange.dispute_resolved:${p.disputeId}`,
  });
  return { changed: true, status: to, releasedBlockIds };
}

export async function handleDisputeResolved(tx: Tx, ev: DomainEvent<DisputeResolvedPayload>, ctx: Ctx) {
  const p = ev.payload;
  if (p?.contextType === 'EXCHANGE' && p.disputeId && p.contextId) await applyDisputeResolution(tx, ctx, p);
}

// ---------------------------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------------------------

/** EXCH-02 expiry: open requests past respond_by (or whose stay already began) → EXPIRED. */
export async function expireStaleRequests(app: AppContext): Promise<number> {
  return withTx(app.pool, async (tx) => {
    const ctx = systemCtx(app, `job-exchange-expiry-${Date.now()}`);
    const rows = await q<ExchangeRow>(
      tx,
      `SELECT * FROM exchange_requests
        WHERE status IN ('REQUESTED','COUNTERED')
          AND (respond_by <= now() OR least(lower(dates_a), lower(dates_b)) <= $1::date)
        ORDER BY respond_by NULLS FIRST LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [todayUtc()],
    );
    for (const ex of rows) {
      await exchangeFsm.transition(tx, ctx, { table: 'exchange_requests', id: ex.id, from: NEGOTIABLE, to: 'EXPIRED', reason: 'no response before deadline', versioned: true, actorType: 'SYSTEM', set: { respond_by: null } });
      await emitEx(tx, ctx, ex, 'exchange.expired', {});
      await notifyBoth(tx, ctx, ex, { templateKey: 'exchange.expired', title: '익스체인지 요청 만료', body: '응답 기한이 지나 요청이 만료되었습니다.', dedupe: 'exchange.expired' });
    }
    return rows.length;
  });
}

/** EXCH-06: CONFIRMED → IN_PROGRESS on the earliest start date; IN_PROGRESS → COMPLETED after the later end date. */
export async function advanceLifecycle(app: AppContext): Promise<{ started: number; completed: number }> {
  return withTx(app.pool, async (tx) => {
    const ctx = systemCtx(app, `job-exchange-lifecycle-${Date.now()}`);
    const today = todayUtc();
    const toStart = await q<ExchangeRow>(
      tx,
      `SELECT * FROM exchange_requests WHERE status = 'CONFIRMED' AND least(lower(dates_a), lower(dates_b)) <= $1::date
        ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [today],
    );
    for (const ex of toStart) {
      await startExchange(tx, ctx, ex);
      ex.status = 'IN_PROGRESS';
    }
    const toFinish = await q<ExchangeRow>(
      tx,
      `SELECT * FROM exchange_requests WHERE status = 'IN_PROGRESS' AND greatest(upper(dates_a), upper(dates_b)) <= $1::date
        ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [today],
    );
    for (const ex of toFinish) await finishExchange(tx, ctx, ex, 'both stays ended');
    return { started: toStart.length, completed: toFinish.length };
  });
}

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------

function nextAction(ex: any, me: string): string | null {
  const party = partyOf(ex, me);
  if (!party) return null;
  const col = party === 'A' ? 'accepted_a_at' : 'accepted_b_at';
  switch (ex.status as ExchangeStatus) {
    case 'REQUESTED':
    case 'COUNTERED':
      return ex.last_offer_by === me ? 'AWAIT_RESPONSE' : 'RESPOND';
    case 'MUTUAL_ACCEPTED':
    case 'VERIFICATION_PENDING':
      return ex.my_safety_ack_pending ? 'SAFETY_ACK' : 'AWAIT_VERIFICATION';
    case 'AGREEMENT_PENDING':
      if (ex.agreement_status === 'SIGNED') return 'CONFIRM';
      return ex[col] ? 'AWAIT_COUNTERPARTY_SIGNATURE' : 'SIGN_AGREEMENT';
    case 'CONFIRMED':
      return 'PREPARE_TRIP';
    case 'IN_PROGRESS':
      return 'COMPLETE_AFTER_STAY';
    case 'COMPLETED':
      return 'LEAVE_REVIEW';
    default:
      return null;
  }
}

const SUMMARY_SQL = `
  SELECT er.*, er.created_at::text AS created_at_text, ag.status AS agreement_status, ag.accepted_a_at, ag.accepted_b_at,
         pa.title AS property_a_title, pa.city AS property_a_city, pb.title AS property_b_title, pb.city AS property_b_city,
         EXISTS (SELECT 1 FROM exchange_verifications v WHERE v.exchange_id = er.id AND v.party_user_id = $1
                  AND v.check_type = 'SAFETY_ACK' AND v.status <> 'PASSED') AS my_safety_ack_pending
    FROM exchange_requests er
    JOIN properties pa ON pa.id = er.property_a_id
    JOIN properties pb ON pb.id = er.property_b_id
    LEFT JOIN exchange_agreements ag ON ag.exchange_id = er.id`;

function mapSummary(r: any, me: string) {
  const party = partyOf(r, me);
  return {
    id: r.id,
    status: r.status,
    role: party === 'A' ? 'REQUESTER' : party === 'B' ? 'RESPONDER' : null,
    nextAction: nextAction(r, me),
    requesterId: r.requester_id,
    responderId: r.responder_id,
    propertyA: { id: r.property_a_id, title: r.property_a_title, city: r.property_a_city },
    propertyB: { id: r.property_b_id, title: r.property_b_title, city: r.property_b_city },
    datesA: parseRange(r.dates_a),
    datesB: parseRange(r.dates_b),
    currentOfferVersion: r.current_offer_version,
    lastOfferBy: r.last_offer_by,
    respondBy: r.respond_by,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listMyExchanges(db: Db, ctx: Ctx, f: { limit: number; cursor?: string; status?: string }) {
  const actor = requireActor(ctx);
  const c = decodeCursor(f.cursor);
  const rows = await q<any>(
    db,
    `${SUMMARY_SQL}
      WHERE (er.requester_id = $1 OR er.responder_id = $1)
        AND ($2::text IS NULL OR er.status = $2)
        AND ($3::timestamptz IS NULL OR (er.created_at, er.id) < ($3::timestamptz, $4::uuid))
      ORDER BY er.created_at DESC, er.id DESC LIMIT $5`,
    [actor.userId, f.status ?? null, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  const items = rows.slice(0, f.limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => mapSummary(r, actor.userId)),
    nextCursor: rows.length > f.limit && last ? encodeCursor({ created_at: last.created_at_text, id: last.id }) : null,
  };
}

/**
 * Parties and exchange case staff (ADMIN/SUPPORT/COMPLIANCE, AAL2) only; everyone else gets 404. Exact addresses only
 * once CONFIRMED. A staff read is audited (ELEVATED_ACCESS); offer messages and addresses are included for staff only
 * with an active case-scoped elevated-access grant on the exchange conversation.
 */
export async function getExchange(db: Db, ctx: Ctx, id: string) {
  const actor = requireActor(ctx);
  const r = await maybeOne<any>(db, `${SUMMARY_SQL} WHERE er.id = $2`, [actor.userId, id]);
  const party = r ? partyOf(r, actor.userId) : null;
  const staff = canStaffRead(ctx);
  if (!r || (!party && !staff)) throw notFound('Exchange');
  const staffView = !party;
  const grantId = staffView ? await staffContentGrant(db, ctx, r.conversation_id) : null;
  const privateContent = !staffView || !!grantId;
  const offers = await q<any>(db, `SELECT * FROM exchange_offers WHERE exchange_id = $1 ORDER BY version`, [id]);
  const verifications = await q<any>(db, `SELECT party_user_id, check_type, status, detail, checked_at FROM exchange_verifications WHERE exchange_id = $1 ORDER BY party_user_id, check_type`, [id]);
  const agreement = await maybeOne<any>(db, `SELECT * FROM exchange_agreements WHERE exchange_id = $1`, [id]);
  const users = await q<{ id: string; display_name: string | null }>(db, `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [[r.requester_id, r.responder_id]]);
  const name = (uid: string) => users.find((u) => u.id === uid)?.display_name ?? null;
  const offerView = (o: any) => (privateContent ? mapOffer(o) : { ...mapOffer(o), message: null, messageWithheld: o.message != null });
  let addresses: Record<string, unknown> | null = null;
  if (ADDRESS_VISIBLE.includes(r.status) && privateContent) {
    const addr = await q<any>(db, `SELECT property_id, line1, line2, postal_code, city, region, country FROM property_addresses WHERE property_id = ANY($1::uuid[])`, [[r.property_a_id, r.property_b_id]]);
    const pick = (pid: string) => {
      const x = addr.find((a) => a.property_id === pid);
      return x ? { line1: x.line1, line2: x.line2, postalCode: x.postal_code, city: x.city, region: x.region, country: x.country } : null;
    };
    addresses = { A: pick(r.property_a_id), B: pick(r.property_b_id) };
  }
  if (staffView) {
    await audit(db, ctx, { action: 'exchange.read', resourceType: 'exchange', resourceId: id, after: { grantId, privateContent }, category: 'ELEVATED_ACCESS' });
  }
  const summary = mapSummary(r, actor.userId);
  return {
    item: {
      ...summary,
      requester: { id: r.requester_id, displayName: name(r.requester_id) },
      responder: { id: r.responder_id, displayName: name(r.responder_id) },
      acceptedAVersion: r.accepted_a_version,
      acceptedBVersion: r.accepted_b_version,
      currentOffer: offers.length ? offerView(offers.find((o) => o.version === r.current_offer_version) ?? offers[offers.length - 1]) : null,
      offers: offers.map(offerView),
      verifications: verifications.map(checkMapper(actor.userId, staffView)),
      agreement: agreement
        ? { id: agreement.id, status: agreement.status, termsVersion: agreement.terms_version, termsHash: agreement.terms_hash, offerVersion: agreement.offer_version, signedByRequester: !!agreement.accepted_a_at, signedByResponder: !!agreement.accepted_b_at }
        : null,
      addresses,
      ...(staffView ? { staffAccess: { elevatedGrantId: grantId, privateContent } } : {}),
      confirmedAt: r.confirmed_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      cancelledAt: r.cancelled_at,
      version: r.version,
    },
  };
}
