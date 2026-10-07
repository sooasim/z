import { randomBytes } from 'node:crypto';
import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { isStaff } from '../../platform/auth.js';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { StateMachine } from '../../platform/fsm.js';
import { assertHostCanPublish } from '../hosts/service.js';
import { evaluatePropertyCompliance, syncPaidBooking, type ComplianceResult } from '../compliance/service.js';
import { listPropertyMedia, toPropertyMediaDto } from '../media/service.js';
import { geocode, publicCoordinates } from '../geo/service.js';

export type PropertyStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'UNLISTED' | 'BLOCKED' | 'ARCHIVED';
export const propertyFsm = new StateMachine<PropertyStatus>('PROPERTY', {
  DRAFT: ['IN_REVIEW', 'PUBLISHED', 'BLOCKED', 'ARCHIVED'],
  IN_REVIEW: ['PUBLISHED', 'DRAFT', 'BLOCKED', 'ARCHIVED'],
  PUBLISHED: ['UNLISTED', 'BLOCKED', 'ARCHIVED'],
  UNLISTED: ['PUBLISHED', 'IN_REVIEW', 'BLOCKED', 'ARCHIVED'],
  BLOCKED: ['UNLISTED', 'ARCHIVED'],
  ARCHIVED: [],
});

export const PROPERTY_TYPES = ['APARTMENT', 'HOUSE', 'VILLA', 'HANOK', 'GUESTHOUSE', 'ROOM', 'STUDIO', 'OTHER'] as const;
export const ROOM_TYPES = ['ENTIRE', 'PRIVATE_ROOM', 'SHARED_ROOM'] as const;
export const MIN_DESCRIPTION = 50;
export const MIN_MEDIA = 3;

export interface AddressInput { line1: string; line2?: string | null; postalCode?: string | null; city?: string | null; region?: string | null; country?: string | null; publicAreaLabel?: string | null }
export interface HouseRulesInput { smokingAllowed?: boolean; petsAllowed?: boolean; eventsAllowed?: boolean; quietHours?: string | null; extraRules?: string | null }
export interface PropertyInput {
  title?: string; summary?: string | null; description?: string | null;
  propertyType?: (typeof PROPERTY_TYPES)[number]; roomType?: (typeof ROOM_TYPES)[number];
  maxGuests?: number; bedrooms?: number; beds?: number; bathrooms?: number;
  lat?: number | null; lng?: number | null; country?: string; region?: string | null; city?: string | null; timezone?: string;
  rentalEnabled?: boolean; exchangeEnabled?: boolean; instantBook?: boolean;
  basePriceMinor?: number | null; cleaningFeeMinor?: number; currency?: string;
  minNights?: number; maxNights?: number; checkInTime?: string; checkOutTime?: string;
  cancellationPolicyCode?: string | null;
  address?: AddressInput | null; houseRules?: HouseRulesInput | null; amenities?: string[];
}

const COLUMNS: Record<string, string> = {
  title: 'title', summary: 'summary', description: 'description', propertyType: 'property_type', roomType: 'room_type',
  maxGuests: 'max_guests', bedrooms: 'bedrooms', beds: 'beds', bathrooms: 'bathrooms', lat: 'lat', lng: 'lng',
  country: 'country', region: 'region', city: 'city', timezone: 'timezone', rentalEnabled: 'rental_enabled',
  exchangeEnabled: 'exchange_enabled', instantBook: 'instant_book', basePriceMinor: 'base_price_minor',
  cleaningFeeMinor: 'cleaning_fee_minor', currency: 'currency', minNights: 'min_nights', maxNights: 'max_nights',
  checkInTime: 'check_in_time', checkOutTime: 'check_out_time',
};
/** fields whose change requires a fresh compliance evaluation */
const COMPLIANCE_FIELDS = new Set(['rentalEnabled', 'exchangeEnabled', 'propertyType', 'roomType', 'country', 'region']);

// --- slug ---------------------------------------------------------------------------------------

/** Unicode-aware (Korean-safe) slug: keeps letters/digits of any script, collapses the rest to '-'. */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'stay';
}

async function uniqueSlug(db: Db, title: string): Promise<string> {
  const base = slugify(title);
  for (let i = 0; i < 8; i++) {
    const suffix = randomBytes(4).readUInt32BE(0).toString(36).padStart(6, '0').slice(0, 6);
    const slug = `${base}-${suffix}`;
    const taken = await maybeOne(db, `SELECT 1 FROM properties WHERE slug = $1`, [slug]);
    if (!taken) return slug;
  }
  throw conflict('SLUG_UNAVAILABLE', 'Could not allocate a unique slug; retry');
}

// --- loading / DTOs -----------------------------------------------------------------------------

async function loadForWrite(tx: Tx, actor: Actor, id: string) {
  const p = await maybeOne(tx, `SELECT * FROM properties WHERE id = $1 FOR UPDATE`, [id]);
  if (!p) throw notFound('Property');
  if (p.host_id !== actor.userId) throw forbidden('NOT_PROPERTY_OWNER', 'You do not own this property');
  return p;
}

const canSeePrivate = (actor: Actor | null, p: any) => !!actor && (p.host_id === actor.userId || (isStaff(actor) && actor.aal === 'aal2'));

async function amenitiesOf(db: Db, id: string) {
  return q(
    db,
    `SELECT a.code, a.category, a.label_ko, a.label_en FROM property_amenities pa JOIN amenities a ON a.code = pa.amenity_code
      WHERE pa.property_id = $1 ORDER BY a.category, a.code`,
    [id],
  ).then((rows) => rows.map((a) => ({ code: a.code, category: a.category, labelKo: a.label_ko, labelEn: a.label_en })));
}

const houseRulesDto = (h: any) =>
  h
    ? { smokingAllowed: h.smoking_allowed, petsAllowed: h.pets_allowed, eventsAllowed: h.events_allowed, quietHours: h.quiet_hours, extraRules: h.extra_rules }
    : { smokingAllowed: false, petsAllowed: false, eventsAllowed: false, quietHours: null, extraRules: null };

async function policyOf(db: Db, id: string | null) {
  if (!id) return null;
  const c = await maybeOne(db, `SELECT code, name, tiers, service_fee_refundable FROM cancellation_policies WHERE id = $1`, [id]);
  return c ? { code: c.code, name: c.name, tiers: c.tiers, serviceFeeRefundable: c.service_fee_refundable } : null;
}

function baseDto(p: any) {
  return {
    id: p.id,
    slug: p.slug,
    hostId: p.host_id,
    title: p.title,
    summary: p.summary,
    description: p.description,
    propertyType: p.property_type,
    roomType: p.room_type,
    maxGuests: p.max_guests,
    bedrooms: p.bedrooms,
    beds: p.beds,
    bathrooms: Number(p.bathrooms),
    rentalEnabled: p.rental_enabled,
    exchangeEnabled: p.exchange_enabled,
    paidBookingEnabled: p.paid_booking_enabled,
    instantBook: p.instant_book,
    basePriceMinor: p.base_price_minor,
    cleaningFeeMinor: p.cleaning_fee_minor,
    currency: p.currency,
    minNights: p.min_nights,
    maxNights: p.max_nights,
    checkInTime: String(p.check_in_time).slice(0, 5),
    checkOutTime: String(p.check_out_time).slice(0, 5),
    timezone: p.timezone,
    status: p.status,
    publishedAt: p.published_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** Full owner/staff view (includes the exact address and coordinates). */
export async function ownerView(db: Db, p: any) {
  // sequential on purpose: db may be a single transaction client
  const addr = await maybeOne(db, `SELECT * FROM property_addresses WHERE property_id = $1`, [p.id]);
  const rules = await maybeOne(db, `SELECT * FROM house_rules WHERE property_id = $1`, [p.id]);
  const amenities = await amenitiesOf(db, p.id);
  const media = await listPropertyMedia(db, p.id);
  const policy = await policyOf(db, p.cancellation_policy_id);
  const decision = await maybeOne(db, `SELECT decision, reasons, evaluated_at FROM compliance_decisions WHERE subject_type = 'PROPERTY' AND subject_id = $1 ORDER BY evaluated_at DESC LIMIT 1`, [p.id]);
  return {
    ...baseDto(p),
    location: { country: p.country, region: p.region, city: p.city, lat: p.lat === null ? null : Number(p.lat), lng: p.lng === null ? null : Number(p.lng), approximate: false },
    address: addr
      ? { line1: addr.line1, line2: addr.line2, postalCode: addr.postal_code, city: addr.city, region: addr.region, country: addr.country, publicAreaLabel: addr.public_area_label }
      : null,
    houseRules: houseRulesDto(rules),
    amenities,
    media: media.map(toPropertyMediaDto),
    cancellationPolicy: policy,
    compliance: decision ? { decision: decision.decision, reasons: decision.reasons, evaluatedAt: decision.evaluated_at } : null,
  };
}

/** Public view: no exact address, fuzzed coordinates, READY public media only, host public info + reputation. */
export async function publicView(db: Db, p: any) {
  const addr = await maybeOne(db, `SELECT public_area_label, city, region FROM property_addresses WHERE property_id = $1`, [p.id]);
  const rules = await maybeOne(db, `SELECT * FROM house_rules WHERE property_id = $1`, [p.id]);
  const amenities = await amenitiesOf(db, p.id);
  const media = await listPropertyMedia(db, p.id, true);
  const policy = await policyOf(db, p.cancellation_policy_id);
  const host = await maybeOne(
      db,
      `SELECT u.id, coalesce(hp.display_name, u.display_name) AS display_name, hp.about, hp.verification_status, hp.response_rate,
              u.created_at, (u.identity_verified_at IS NOT NULL) AS identity_verified
         FROM users u LEFT JOIN host_profiles hp ON hp.user_id = u.id WHERE u.id = $1`,
      [p.host_id],
    );
  const rep = await maybeOne(db, `SELECT review_count, rating_avg FROM reputation_scores WHERE target_type = 'PROPERTY' AND target_id = $1`, [p.id]);
  const hostRep = await maybeOne(db, `SELECT review_count, rating_avg FROM reputation_scores WHERE target_type = 'HOST' AND target_id = $1`, [p.host_id]);
  const { hostId: _h, ...rest } = baseDto(p);
  void _h;
  return {
    ...rest,
    location: {
      country: p.country,
      region: p.region,
      city: p.city,
      areaLabel: addr?.public_area_label ?? p.city ?? null,
      ...(publicCoordinates(p.id, p.lat, p.lng) ?? { lat: null, lng: null, approximate: true }),
    },
    houseRules: houseRulesDto(rules),
    amenities,
    media: media.map((m) => ({ id: m.id, url: m.public_url, mimeType: m.mime_type, width: m.width, height: m.height, caption: m.caption, sortOrder: m.sort_order })),
    cancellationPolicy: policy,
    host: host
      ? {
          id: host.id,
          displayName: host.display_name,
          about: host.about,
          verified: host.verification_status === 'VERIFIED',
          identityVerified: host.identity_verified,
          responseRate: host.response_rate === null ? null : Number(host.response_rate),
          memberSince: host.created_at,
          reputation: { reviewCount: hostRep?.review_count ?? 0, ratingAvg: hostRep?.rating_avg ?? null },
        }
      : null,
    reputation: { reviewCount: rep?.review_count ?? 0, ratingAvg: rep?.rating_avg ?? null },
  };
}

// --- writes -------------------------------------------------------------------------------------

async function applyRelated(tx: Tx, ctx: Ctx, id: string, input: PropertyInput) {
  if (input.address !== undefined) {
    if (input.address === null) await tx.query(`DELETE FROM property_addresses WHERE property_id = $1`, [id]);
    else {
      const a = input.address;
      await tx.query(
        `INSERT INTO property_addresses(property_id, line1, line2, postal_code, city, region, country, public_area_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (property_id) DO UPDATE SET line1 = EXCLUDED.line1, line2 = EXCLUDED.line2, postal_code = EXCLUDED.postal_code,
           city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country, public_area_label = EXCLUDED.public_area_label`,
        [id, a.line1, a.line2 ?? null, a.postalCode ?? null, a.city ?? null, a.region ?? null, (a.country ?? 'KR').toUpperCase(), a.publicAreaLabel ?? null],
      );
    }
  }
  if (input.houseRules !== undefined && input.houseRules !== null) {
    const h = input.houseRules;
    const cur = await maybeOne(tx, `SELECT * FROM house_rules WHERE property_id = $1`, [id]);
    const merged = { ...houseRulesDto(cur), ...Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) };
    await tx.query(
      `INSERT INTO house_rules(property_id, smoking_allowed, pets_allowed, events_allowed, quiet_hours, extra_rules) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (property_id) DO UPDATE SET smoking_allowed = EXCLUDED.smoking_allowed, pets_allowed = EXCLUDED.pets_allowed,
         events_allowed = EXCLUDED.events_allowed, quiet_hours = EXCLUDED.quiet_hours, extra_rules = EXCLUDED.extra_rules`,
      [id, merged.smokingAllowed, merged.petsAllowed, merged.eventsAllowed, merged.quietHours, merged.extraRules],
    );
  }
  if (input.amenities !== undefined) await replaceAmenities(tx, id, input.amenities);
  if (input.cancellationPolicyCode !== undefined) {
    let policyId: string | null = null;
    if (input.cancellationPolicyCode !== null) {
      const c = await maybeOne(tx, `SELECT id FROM cancellation_policies WHERE code = $1 AND active`, [input.cancellationPolicyCode]);
      if (!c) throw unprocessable('UNKNOWN_CANCELLATION_POLICY', `Unknown cancellation policy ${input.cancellationPolicyCode}`);
      policyId = c.id;
    }
    await tx.query(`UPDATE properties SET cancellation_policy_id = $2 WHERE id = $1`, [id, policyId]);
  }
  // Fill region (ISO subdivision) / coordinates from the geocoder when missing. Coordinates are only filled from
  // address-precision providers: a city centroid must never masquerade as the listing location.
  const p = await maybeOne(tx, `SELECT p.lat, p.lng, p.region, p.city, a.line1, a.city AS a_city FROM properties p LEFT JOIN property_addresses a ON a.property_id = p.id WHERE p.id = $1`, [id]);
  if (p && (p.region === null || p.lat === null) && (p.line1 || p.city || p.a_city)) {
    const query = [p.a_city ?? p.city, p.line1].filter(Boolean).join(' ');
    const [hit] = await geocode(ctx.app, query, { limit: 1 }).catch(() => []);
    if (hit) {
      const exact = hit.precision === 'ADDRESS' || hit.precision === 'POI';
      await tx.query(
        `UPDATE properties SET region = coalesce(region, $2), lat = CASE WHEN lat IS NULL AND $5 THEN $3 ELSE lat END,
            lng = CASE WHEN lng IS NULL AND $5 THEN $4 ELSE lng END WHERE id = $1`,
        [id, hit.region ?? null, hit.lat, hit.lng, exact],
      );
    }
  }
}

export async function replaceAmenities(tx: Tx, propertyId: string, codes: string[]) {
  const uniq = [...new Set(codes)];
  if (uniq.length) {
    const known = await q(tx, `SELECT code FROM amenities WHERE code = ANY($1::text[])`, [uniq]);
    const missing = uniq.filter((c) => !known.some((k) => k.code === c));
    if (missing.length) throw unprocessable('UNKNOWN_AMENITY', `Unknown amenity codes: ${missing.join(', ')}`, { missing });
  }
  await tx.query(`DELETE FROM property_amenities WHERE property_id = $1 AND NOT (amenity_code = ANY($2::text[]))`, [propertyId, uniq]);
  for (const c of uniq) await tx.query(`INSERT INTO property_amenities(property_id, amenity_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [propertyId, c]);
}

function columnValues(input: PropertyInput) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(COLUMNS)) {
    const v = (input as any)[k];
    if (v === undefined) continue;
    cols.push(col);
    vals.push(k === 'country' || k === 'currency' ? String(v).toUpperCase() : v);
  }
  return { cols, vals };
}

export async function createProperty(ctx: Ctx, actor: Actor, input: PropertyInput & { title: string; propertyType: string }) {
  return withTx(ctx.app.pool, async (tx) => {
    const slug = await uniqueSlug(tx, input.title);
    const { cols, vals } = columnValues(input);
    const params = [actor.userId, slug, ...vals];
    const row = await maybeOne(
      tx,
      `INSERT INTO properties(host_id, slug, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      params,
    );
    await applyRelated(tx, ctx, row.id, input);
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: row.id, eventType: 'property.created', payload: { propertyId: row.id, hostId: actor.userId } });
    const p = await maybeOne(tx, `SELECT * FROM properties WHERE id = $1`, [row.id]);
    return ownerView(tx, p);
  });
}

export async function updateProperty(ctx: Ctx, actor: Actor, id: string, input: PropertyInput) {
  return withTx(ctx.app.pool, async (tx) => {
    const before = await loadForWrite(tx, actor, id);
    if (before.status === 'ARCHIVED') throw conflict('PROPERTY_ARCHIVED', 'Archived properties cannot be edited');
    const { cols, vals } = columnValues(input);
    if (cols.length) {
      await tx.query(`UPDATE properties SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...vals]);
    } else {
      await tx.query(`UPDATE properties SET updated_at = now() WHERE id = $1`, [id]);
    }
    await applyRelated(tx, ctx, id, input);
    const fields = Object.keys(input).filter((k) => (input as any)[k] !== undefined);
    let p = await maybeOne(tx, `SELECT * FROM properties WHERE id = $1`, [id]);
    if (p.status === 'PUBLISHED') {
      // a live listing must stay publishable after the edit
      const errors = await validateForPublish(tx, p);
      if (errors.length) throw unprocessable('PUBLISH_VALIDATION_FAILED', 'Edit would make the published listing invalid', { errors });
      if (fields.some((f) => COMPLIANCE_FIELDS.has(f))) {
        await syncPaidBooking(tx, ctx, id, 'listing edited');
        p = await maybeOne(tx, `SELECT * FROM properties WHERE id = $1`, [id]);
      }
    }
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType: 'property.updated', payload: { propertyId: id, fields } });
    return ownerView(tx, p);
  });
}

export async function setAmenities(ctx: Ctx, actor: Actor, id: string, codes: string[]) {
  return withTx(ctx.app.pool, async (tx) => {
    const p = await loadForWrite(tx, actor, id);
    if (p.status === 'ARCHIVED') throw conflict('PROPERTY_ARCHIVED', 'Archived properties cannot be edited');
    await replaceAmenities(tx, id, codes);
    await tx.query(`UPDATE properties SET updated_at = now() WHERE id = $1`, [id]);
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType: 'property.updated', payload: { propertyId: id, fields: ['amenities'] } });
    return amenitiesOf(tx, id);
  });
}

/** Required content for publication. Returns machine-readable error codes (empty = valid). */
export async function validateForPublish(db: Db, p: any): Promise<string[]> {
  const errors: string[] = [];
  if (!p.title || p.title.trim().length < 2) errors.push('TITLE_REQUIRED');
  if (!p.description || p.description.trim().length < MIN_DESCRIPTION) errors.push('DESCRIPTION_MIN_50');
  if (!p.rental_enabled && !p.exchange_enabled) errors.push('LISTING_MODE_REQUIRED');
  if (p.rental_enabled && (p.base_price_minor === null || p.base_price_minor <= 0)) errors.push('BASE_PRICE_REQUIRED');
  if (!p.max_guests || p.max_guests < 1) errors.push('MAX_GUESTS_REQUIRED');
  if (p.lat === null || p.lng === null) errors.push('GEO_REQUIRED');
  const addr = await maybeOne(db, `SELECT 1 FROM property_addresses WHERE property_id = $1 AND length(trim(line1)) > 0`, [p.id]);
  if (!addr) errors.push('ADDRESS_REQUIRED');
  const media = await maybeOne<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
      WHERE pm.property_id = $1 AND m.status = 'READY' AND m.visibility = 'PUBLIC'`,
    [p.id],
  );
  if ((media?.n ?? 0) < MIN_MEDIA) errors.push('MEDIA_MIN_3');
  return errors;
}

export type PublishOutcome = 'PUBLISHED' | 'IN_REVIEW' | 'DENIED';

/**
 * POST /v1/properties/:id/publish (also re-lists UNLISTED). Content validation → approved host → compliance gate.
 * Rental listings get paid_booking_enabled only on ALLOW. Rental-only listings without ALLOW go to IN_REVIEW
 * (REVIEW) or are refused (DENY); listings that also offer exchange publish exchange-only.
 */
export async function publishProperty(ctx: Ctx, actor: Actor, id: string) {
  const res = await withTx(ctx.app.pool, async (tx) => {
    const p = await loadForWrite(tx, actor, id);
    if (!['DRAFT', 'IN_REVIEW', 'UNLISTED'].includes(p.status)) {
      throw conflict('INVALID_STATE_TRANSITION', `Property is ${p.status}; only DRAFT, IN_REVIEW or UNLISTED listings can be published`, { from: p.status });
    }
    const errors = await validateForPublish(tx, p);
    if (errors.length) throw unprocessable('PUBLISH_VALIDATION_FAILED', 'Listing is missing required content', { errors });
    await assertHostCanPublish(tx, actor.userId);
    const compliance: ComplianceResult = await evaluatePropertyCompliance(tx, id, { persist: true });

    let outcome: PublishOutcome;
    let paid = false;
    if (p.rental_enabled && compliance.decision === 'ALLOW') {
      outcome = 'PUBLISHED';
      paid = true;
    } else if (p.rental_enabled && p.exchange_enabled) {
      outcome = 'PUBLISHED'; // exchange-only until compliance allows paid booking
    } else if (p.rental_enabled) {
      outcome = compliance.decision === 'DENY' ? 'DENIED' : 'IN_REVIEW';
    } else {
      outcome = 'PUBLISHED'; // exchange-only listing
    }

    if (outcome === 'PUBLISHED') {
      const { row } = await propertyFsm.transition(tx, ctx, {
        table: 'properties', id, to: 'PUBLISHED', reason: paid ? 'published (paid booking allowed)' : 'published without paid booking',
        metadata: { compliance: compliance.decision },
        set: { paid_booking_enabled: paid, published_at: p.published_at ?? new Date() },
      });
      await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType: 'property.published', payload: { propertyId: id, hostId: p.host_id, slug: row.slug, paidBookingEnabled: paid, compliance: compliance.decision } });
    } else if (outcome === 'IN_REVIEW' && p.status !== 'IN_REVIEW') {
      await propertyFsm.transition(tx, ctx, { table: 'properties', id, to: 'IN_REVIEW', reason: 'awaiting compliance review', metadata: { compliance: compliance.decision, reasons: compliance.reasons }, set: { paid_booking_enabled: false } });
      await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType: 'property.updated', payload: { propertyId: id, fields: ['status'], status: 'IN_REVIEW' } });
    }
    const fresh = await maybeOne(tx, `SELECT * FROM properties WHERE id = $1`, [id]);
    return { outcome, compliance, item: await ownerView(tx, fresh) };
  });
  if (res.outcome === 'DENIED') {
    throw unprocessable('COMPLIANCE_DENIED', 'Paid listing cannot be published: compliance requirements are not met', { reasons: res.compliance.reasons });
  }
  return res;
}

async function simpleTransition(ctx: Ctx, actor: Actor, id: string, to: PropertyStatus, eventType: string, reason: string) {
  return withTx(ctx.app.pool, async (tx) => {
    const p = await loadForWrite(tx, actor, id);
    await propertyFsm.transition(tx, ctx, { table: 'properties', id, to, reason, set: to === 'PUBLISHED' ? {} : { paid_booking_enabled: false } });
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType, payload: { propertyId: id, hostId: p.host_id, from: p.status, to } });
    return ownerView(tx, await maybeOne(tx, `SELECT * FROM properties WHERE id = $1`, [id]));
  });
}

export const unlistProperty = (ctx: Ctx, actor: Actor, id: string) => simpleTransition(ctx, actor, id, 'UNLISTED', 'property.unlisted', 'unlisted by host');
export const archiveProperty = (ctx: Ctx, actor: Actor, id: string) => simpleTransition(ctx, actor, id, 'ARCHIVED', 'property.archived', 'archived by host');
export const withdrawProperty = (ctx: Ctx, actor: Actor, id: string) => simpleTransition(ctx, actor, id, 'DRAFT', 'property.updated', 'review withdrawn by host');

/** Admin / compliance block (staff AAL2 enforced by route). Audited under COMPLIANCE. */
export async function blockProperty(ctx: Ctx, id: string, reason: string) {
  return withTx(ctx.app.pool, async (tx) => {
    const before = await maybeOne(tx, `SELECT * FROM properties WHERE id = $1 FOR UPDATE`, [id]);
    if (!before) throw notFound('Property');
    const { row } = await propertyFsm.transition(tx, ctx, { table: 'properties', id, to: 'BLOCKED', reason, actorType: 'ADMIN', set: { paid_booking_enabled: false } });
    await audit(tx, ctx, { action: 'property.blocked', resourceType: 'property', resourceId: id, before: { status: before.status, paidBookingEnabled: before.paid_booking_enabled }, after: { status: row.status }, reason, category: 'COMPLIANCE' });
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType: 'listing.blocked', payload: { propertyId: id, hostId: row.host_id, scope: 'LISTING', reason } });
    return ownerView(tx, row);
  });
}

export async function unblockProperty(ctx: Ctx, id: string, reason: string) {
  return withTx(ctx.app.pool, async (tx) => {
    const { row, from } = await propertyFsm.transition(tx, ctx, { table: 'properties', id, from: 'BLOCKED', to: 'UNLISTED', reason, actorType: 'ADMIN' });
    await audit(tx, ctx, { action: 'property.unblocked', resourceType: 'property', resourceId: id, before: { status: from }, after: { status: row.status }, reason, category: 'COMPLIANCE' });
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: id, eventType: 'property.unblocked', payload: { propertyId: id, hostId: row.host_id, reason } });
    return ownerView(tx, row);
  });
}

// --- reads --------------------------------------------------------------------------------------

export async function getProperty(ctx: Ctx, actor: Actor | null, id: string) {
  const p = await maybeOne(ctx.app.pool, `SELECT * FROM properties WHERE id = $1`, [id]);
  if (!p) throw notFound('Property');
  if (canSeePrivate(actor, p)) return ownerView(ctx.app.pool, p);
  if (p.status === 'PUBLISHED') return publicView(ctx.app.pool, p);
  throw notFound('Property');
}

export async function getPublicBySlug(db: Db, slug: string) {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE slug = $1 AND status = 'PUBLISHED'`, [slug]);
  if (!p) throw notFound('Property');
  return publicView(db, p);
}

export async function listHostProperties(db: Db, actor: Actor, status?: PropertyStatus) {
  const rows = await q(
    db,
    `SELECT p.*, (SELECT m.public_url FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
                   WHERE pm.property_id = p.id AND m.visibility = 'PUBLIC' AND m.status = 'READY' ORDER BY pm.sort_order LIMIT 1) AS cover_url
       FROM properties p WHERE p.host_id = $1 AND ($2::text IS NULL OR p.status = $2) ORDER BY p.created_at DESC LIMIT 500`,
    [actor.userId, status ?? null],
  );
  return rows.map((p) => ({ ...baseDto(p), city: p.city, region: p.region, coverUrl: p.cover_url }));
}

export async function listPublicProperties(db: Db, f: { hostId?: string; city?: string; limit: number; offset: number }) {
  const rows = await q(
    db,
    `SELECT p.*, (SELECT m.public_url FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
                   WHERE pm.property_id = p.id AND m.visibility = 'PUBLIC' AND m.status = 'READY' ORDER BY pm.sort_order LIMIT 1) AS cover_url
       FROM properties p WHERE p.status = 'PUBLISHED' AND ($1::uuid IS NULL OR p.host_id = $1) AND ($2::text IS NULL OR p.city ILIKE $2)
      ORDER BY p.published_at DESC NULLS LAST, p.id LIMIT $3 OFFSET $4`,
    [f.hostId ?? null, f.city ?? null, f.limit, f.offset],
  );
  return rows.map((p) => {
    const { hostId, ...rest } = baseDto(p);
    return { ...rest, hostId, city: p.city, region: p.region, coverUrl: p.cover_url, location: publicCoordinates(p.id, p.lat, p.lng) };
  });
}

export async function listAmenities(db: Db) {
  return (await q(db, `SELECT code, category, label_ko, label_en FROM amenities ORDER BY category, code`)).map((a) => ({
    code: a.code, category: a.category, labelKo: a.label_ko, labelEn: a.label_en,
  }));
}

export async function listCancellationPolicies(db: Db) {
  return (await q(db, `SELECT code, name, tiers, service_fee_refundable FROM cancellation_policies WHERE active ORDER BY code`)).map((c) => ({
    code: c.code, name: c.name, tiers: c.tiers, serviceFeeRefundable: c.service_fee_refundable,
  }));
}

/**
 * Exact location for parties entitled to it (booking/exchange modules call this after confirmation).
 * The caller is responsible for the entitlement check.
 */
export async function getExactLocation(db: Db, propertyId: string) {
  const r = await maybeOne(
    db,
    `SELECT p.lat, p.lng, a.line1, a.line2, a.postal_code, a.city, a.region, a.country FROM properties p
       LEFT JOIN property_addresses a ON a.property_id = p.id WHERE p.id = $1`,
    [propertyId],
  );
  if (!r) throw notFound('Property');
  return { lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng), line1: r.line1, line2: r.line2, postalCode: r.postal_code, city: r.city, region: r.region, country: r.country };
}

export function assertValidNights(min?: number, max?: number) {
  if (min !== undefined && max !== undefined && max < min) throw badRequest('INVALID_NIGHTS', 'maxNights must be ≥ minNights');
}
