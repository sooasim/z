import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import { badRequest } from '../../platform/errors.js';
import { ACTIVE_BOOKING_STATUSES } from './fsm.js';
import { subtractIntervals, type Interval } from './availability.js';
import { publicProfile, type GuideProfileRow } from './profile.js';
import type { SearchInput } from './schemas.js';

/** Ranking weights (GUIDE-03). Score is normalised over the components that apply to the query. */
export const RANK_WEIGHTS = { language: 0.35, interest: 0.25, availability: 0.2, rating: 0.1, distance: 0.1 } as const;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GuideMatch {
  guide: ReturnType<typeof publicProfile>;
  score: number;
  components: Partial<Record<keyof typeof RANK_WEIGHTS, number>>;
  explanation: string[];
  availability: 'AVAILABLE' | 'ON_REQUEST' | 'UNAVAILABLE' | null;
  distanceKm: number | null;
}

export type SearchArgs = Omit<SearchInput, 'from' | 'to'> & { from?: string | Date; to?: string | Date; excludeUserId?: string };

export async function searchGuides(db: Db, s: SearchArgs): Promise<GuideMatch[]> {
  const langs = (s.languages ?? []).map((x) => x.toLowerCase());
  const interests = (s.interests ?? []).map((x) => x.toLowerCase());
  const from = s.from ? new Date(s.from) : null;
  const to = s.to ? new Date(s.to) : null;
  if ((from && !to) || (!from && to)) throw badRequest('INVALID_RANGE', 'from and to must be given together');
  if (from && to && to <= from) throw badRequest('INVALID_RANGE', '`to` must be after `from`');
  if ((s.lat == null) !== (s.lng == null)) throw badRequest('INVALID_LOCATION', 'lat and lng must be given together');

  const where: string[] = [`g.status = 'PUBLISHED'`, `u.status = 'ACTIVE'`];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (s.city) where.push(`lower(g.city) = lower(${p(s.city)})`);
  if (s.region) where.push(`${p(s.region.toLowerCase())} = ANY(g.regions)`);
  if (langs.length) where.push(`g.languages && ${p(langs)}::text[]`);
  if (s.types?.length) where.push(`g.guide_type = ANY(${p(s.types)}::text[])`);
  if (s.pricing === 'free') where.push(`g.paid_enabled = false`);
  if (s.pricing === 'paid') where.push(`g.paid_enabled = true`);
  if (s.minRating != null) where.push(`coalesce(g.rating_avg, 0) >= ${p(s.minRating)}`);
  if (s.maxPriceMinor != null) where.push(`(g.paid_enabled = false OR coalesce(g.hourly_price_minor, 0) <= ${p(s.maxPriceMinor)})`);
  if (s.excludeUserId) where.push(`g.user_id <> ${p(s.excludeUserId)}`);
  const rows = await q<GuideProfileRow & { display_name: string | null }>(
    db,
    `SELECT g.*, u.display_name FROM guide_profiles g JOIN users u ON u.id = g.user_id
      WHERE ${where.join(' AND ')} ORDER BY g.rating_avg DESC NULLS LAST, g.updated_at DESC LIMIT 300`,
    params,
  );
  if (!rows.length) return [];

  // batch availability for the window
  const avail = new Map<string, 'AVAILABLE' | 'ON_REQUEST' | 'UNAVAILABLE'>();
  if (from && to) {
    const ids = rows.map((r) => r.user_id);
    const anySlots = new Set(
      (await q<{ guide_id: string }>(db, `SELECT DISTINCT guide_id FROM guide_availability WHERE guide_id = ANY($1::uuid[]) AND status = 'AVAILABLE' AND end_at > now()`, [ids])).map((r) => r.guide_id),
    );
    const slots = await q<{ guide_id: string; start_at: Date; end_at: Date; status: string }>(
      db,
      `SELECT guide_id, start_at, end_at, status FROM guide_availability WHERE guide_id = ANY($1::uuid[]) AND start_at < $3 AND end_at > $2`,
      [ids, from, to],
    );
    const books = await q<{ guide_id: string; start_at: Date; end_at: Date }>(
      db,
      `SELECT guide_id, start_at, end_at FROM guide_bookings WHERE guide_id = ANY($1::uuid[]) AND status = ANY($4::text[]) AND start_at < $3 AND end_at > $2`,
      [ids, from, to, ACTIVE_BOOKING_STATUSES],
    );
    const clip = (r: { start_at: Date; end_at: Date }): Interval => ({ start: Math.max(r.start_at.getTime(), from.getTime()), end: Math.min(r.end_at.getTime(), to.getTime()) });
    for (const id of ids) {
      const mine = slots.filter((x) => x.guide_id === id);
      const blocked = mine.filter((x) => x.status === 'BLOCKED').map(clip);
      const booked = books.filter((x) => x.guide_id === id).map(clip);
      if (blocked.length || booked.length) {
        // any blocked/booked overlap with the window means the guide can't take the whole window
        avail.set(id, 'UNAVAILABLE');
        continue;
      }
      if (!anySlots.has(id)) { avail.set(id, 'ON_REQUEST'); continue; }
      const free = subtractIntervals(mine.filter((x) => x.status === 'AVAILABLE').map(clip), []);
      avail.set(id, free.length === 1 && free[0].start <= from.getTime() && free[0].end >= to.getTime() ? 'AVAILABLE' : 'UNAVAILABLE');
    }
  }

  const out: GuideMatch[] = [];
  for (const r of rows) {
    const comp: GuideMatch['components'] = {};
    const why: string[] = [];
    if (langs.length) {
      const m = langs.filter((l) => r.languages.includes(l));
      comp.language = m.length / langs.length;
      why.push(`Speaks ${m.join(', ')} (${m.length}/${langs.length} requested languages)`);
    }
    if (interests.length) {
      const m = interests.filter((i) => r.interests.includes(i) || r.specialties.includes(i));
      comp.interest = m.length / interests.length;
      if (m.length) why.push(`Shares interests: ${m.join(', ')}`);
      else why.push('No overlapping interests');
    }
    let availability: GuideMatch['availability'] = null;
    if (from && to) {
      availability = avail.get(r.user_id) ?? 'UNAVAILABLE';
      if (s.availableOnly && availability !== 'AVAILABLE') continue;
      comp.availability = availability === 'AVAILABLE' ? 1 : availability === 'ON_REQUEST' ? 0.5 : 0;
      why.push(availability === 'AVAILABLE' ? 'Available for the whole requested time' : availability === 'ON_REQUEST' ? 'No published schedule; availability on request' : 'Not available for the requested time');
    }
    const rating = r.rating_avg == null ? null : Number(r.rating_avg);
    comp.rating = rating == null ? 0.6 : rating / 5;
    why.push(rating == null ? 'New guide (no ratings yet)' : `Rated ${rating.toFixed(2)}/5`);
    let distanceKm: number | null = null;
    if (s.lat != null && s.lng != null) {
      if (r.lat != null && r.lng != null) {
        distanceKm = Math.round(haversineKm(s.lat, s.lng, Number(r.lat), Number(r.lng)) * 10) / 10;
        comp.distance = 1 / (1 + distanceKm / 5);
        why.push(`About ${distanceKm} km away`);
      } else comp.distance = 0;
    }
    if (s.city && r.city) why.push(`Based in ${r.city}`);
    let wsum = 0, ssum = 0;
    for (const [k, v] of Object.entries(comp) as Array<[keyof typeof RANK_WEIGHTS, number]>) {
      wsum += RANK_WEIGHTS[k];
      ssum += RANK_WEIGHTS[k] * v;
    }
    const score = wsum ? Math.round((ssum / wsum) * 10000) / 10000 : 0;
    out.push({ guide: publicProfile(r), score, components: comp, explanation: why, availability, distanceKm });
  }
  out.sort((a, b) => b.score - a.score || (b.guide.ratingAvg ?? 0) - (a.guide.ratingAvg ?? 0) || a.guide.guideId.localeCompare(b.guide.guideId));
  return out.slice(0, s.limit ?? 20);
}
