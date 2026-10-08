/** Listing catalog built from the recorded search/detail responses, plus a local search engine and pricing. */
import { F, allItems, anyBody } from './fixtures';
import { entities } from './store';
import { addDays, clone, dateRange, fld, itemOf, nightsBetween, nowIso, today, type Obj } from './util';

let catalogCache: Obj[] | null = null;
/** Every listing seen in recorded search responses (search-item shape), plus listings published in the demo. */
export function catalog(): Obj[] {
  if (!catalogCache) {
    const seen = allItems((p) => p === '/v1/search/properties');
    catalogCache = seen.filter((x) => x && x.id && x.slug);
  }
  const local = entities('property').filter((p) => p.status === 'PUBLISHED').map(searchItemOf);
  const ids = new Set(local.map((x) => x.id));
  return [...local, ...catalogCache.filter((x) => !ids.has(x.id))].map(clone);
}
export function invalidateCatalog() {
  catalogCache = null;
}

/** Detail (`/v1/properties/by-slug/:slug` item) for a listing id or slug. */
export function propertyDetail(idOrSlug: string): Obj | undefined {
  const local = entities('property').find((p) => p.id === idOrSlug || p.slug === idOrSlug);
  if (local) return clone(local);
  const s = catalog().find((x) => x.id === idOrSlug || x.slug === idOrSlug);
  const slug = s?.slug ?? idOrSlug;
  const d = anyBody(`/v1/properties/by-slug/${slug}`) ?? (s ? anyBody(`/v1/properties/${s.id}`) : undefined) ?? anyBody(`/v1/properties/${idOrSlug}`);
  const item = itemOf(d);
  if (item && item.id) return item;
  return s ? { ...s, basePriceMinor: s.priceMinor, cleaningFeeMinor: 30000, location: s.location } : undefined;
}

export function hostIdOf(propertyId: string): string | undefined {
  const d = propertyDetail(propertyId);
  return fld(d?.host, 'id', 'userId', 'hostId') ?? fld(d, 'hostId', 'ownerId');
}

export function searchItemOf(p: Obj): Obj {
  const media = Array.isArray(p.media) ? p.media.map((m: any) => m.url).filter(Boolean) : p.photoUrls ?? [];
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    summary: p.summary ?? null,
    city: p.location?.city ?? p.city ?? null,
    region: p.location?.region ?? p.region ?? null,
    areaLabel: p.location?.areaLabel ?? p.areaLabel ?? null,
    propertyType: p.propertyType,
    roomType: p.roomType ?? 'ENTIRE',
    maxGuests: p.maxGuests,
    bedrooms: p.bedrooms,
    beds: p.beds,
    bathrooms: p.bathrooms,
    priceMinor: p.basePriceMinor ?? p.priceMinor ?? null,
    currency: p.currency ?? 'KRW',
    rentalEnabled: !!p.rentalEnabled,
    paidBookingEnabled: !!p.paidBookingEnabled,
    exchangeEnabled: !!p.exchangeEnabled,
    instantBook: !!p.instantBook,
    amenities: (p.amenities ?? []).map((a: any) => (typeof a === 'string' ? a : a.code)),
    coverUrl: media[0] ?? null,
    photoUrls: media,
    ratingAvg: null,
    reviewCount: 0,
    location: p.location ? { lat: p.location.lat, lng: p.location.lng, approximate: true } : null,
    distanceM: null,
    hostId: p.hostId,
  };
}

// ------------------------------------------------------------------------------------------- availability
/** Nights blocked by demo-created stays/holds (on top of what the recorded calendars already show). */
export function locallyBookedNights(propertyId: string): Set<string> {
  const out = new Set<string>();
  for (const r of entities('reservation')) {
    if (r.propertyId !== propertyId) continue;
    if (!['HELD', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'].includes(r.status)) continue;
    if (r.status === 'HELD' && r.holdExpiresAt && Date.parse(r.holdExpiresAt) < Date.now()) continue;
    for (const d of dateRange(r.checkIn, r.checkOut)) out.add(d);
  }
  return out;
}
/** Nights released by demo cancellations of recorded stays. */
export function locallyReleasedNights(propertyId: string): Set<string> {
  const out = new Set<string>();
  for (const r of entities('reservation')) {
    if (r.propertyId !== propertyId || !['CANCELLED', 'EXPIRED', 'CANCELLED_BY_GUEST', 'CANCELLED_BY_HOST'].includes(r.status)) continue;
    for (const d of dateRange(r.checkIn, r.checkOut)) out.add(d);
  }
  return out;
}

/** Public calendar days (recorded) keyed by date. */
export function recordedDays(propertyId: string): Map<string, Obj> {
  const m = new Map<string, Obj>();
  const b = anyBody(`/v1/properties/${propertyId}/calendar`);
  for (const d of fld(itemOf(b), 'days') ?? []) m.set(d.date, d);
  return m;
}

export function publicCalendar(propertyId: string, from: string, to: string): Obj {
  const d = propertyDetail(propertyId);
  const rec = recordedDays(propertyId);
  const booked = locallyBookedNights(propertyId);
  const released = locallyReleasedNights(propertyId);
  const days: Obj[] = [];
  const start = from || today();
  const end = to || addDays(start, 365);
  for (const date of dateRange(start, end)) {
    const r = rec.get(date);
    let status = r?.status ?? 'available';
    if (booked.has(date)) status = 'booked';
    else if (status === 'booked' && released.has(date)) status = 'available';
    days.push({ date, status, priceMinor: r?.priceMinor ?? d?.basePriceMinor ?? null, minNights: r?.minNights ?? d?.minNights ?? 1 });
  }
  return { item: { propertyId, currency: d?.currency ?? 'KRW', from: start, to: end, days } };
}

// ------------------------------------------------------------------------------------------- search
const CITY_ALIASES: Array<[RegExp, string]> = [
  [/서울|seoul|성수|홍대|강남|종로|북촌|연남/i, 'seoul'],
  [/제주|jeju|서귀포|애월|한림/i, 'jeju'],
  [/부산|busan|해운대|광안/i, 'busan'],
  [/강릉|gangneung/i, 'gangneung'],
  [/경주|gyeongju/i, 'gyeongju'],
  [/속초|sokcho|양양/i, 'sokcho'],
];
const AMENITY_ALIAS: Record<string, string[]> = {
  WIFI: ['wifi'],
  KITCHEN: ['kitchen'],
  WASHER: ['washer'],
  AIR_CONDITIONING: ['aircon', 'air_conditioning'],
  PARKING: ['parking', 'free_parking'],
  WORKSPACE: ['workspace', 'desk'],
  PET_FRIENDLY: ['pets', 'pet_friendly', 'pets_allowed'],
};

function matchesQuery(p: Obj, q: string): boolean {
  const hay = [p.title, p.summary, p.city, p.region, p.areaLabel, p.slug].filter(Boolean).join(' ').toLowerCase();
  const ql = q.trim().toLowerCase();
  if (!ql) return true;
  if (hay.includes(ql)) return true;
  for (const [re, city] of CITY_ALIASES) if (re.test(q) && (String(p.city || '').toLowerCase() === city || re.test(hay))) return true;
  return ql.split(/\s+/).every((w) => hay.includes(w));
}

export function searchProperties(query: URLSearchParams): Obj {
  const q = query.get('q') ?? query.get('city') ?? '';
  const guests = Number(query.get('guests') || 0);
  const types = (query.get('propertyType') ?? query.get('type') ?? '').split(',').filter(Boolean).map((x) => x.toUpperCase());
  const amen = (query.get('amenities') ?? '').split(',').filter(Boolean);
  const pmin = Number(query.get('priceMin') || 0);
  const pmax = Number(query.get('priceMax') || 0);
  const mode = query.get('mode');
  const bbox = (query.get('bbox') ?? '').split(',').map(Number);
  const checkIn = query.get('checkIn') ?? '';
  const checkOut = query.get('checkOut') ?? '';
  const sort = query.get('sort') ?? 'relevance';
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') || 24)));
  const page = Math.max(1, Number(query.get('page') || 1));
  const dated = !!(checkIn && checkOut && nightsBetween(checkIn, checkOut) > 0);

  let rows = catalog().filter((p) => {
    if (q && !matchesQuery(p, q)) return false;
    if (guests && Number(p.maxGuests || 0) < guests) return false;
    if (types.length && !types.includes(String(p.propertyType || '').toUpperCase())) return false;
    if (amen.length) {
      const have = (p.amenities ?? []).map((a: string) => String(a).toLowerCase());
      if (!amen.every((a) => (AMENITY_ALIAS[a.toUpperCase()] ?? [a.toLowerCase()]).some((x) => have.includes(x)))) return false;
    }
    if (pmin && Number(p.priceMinor ?? 0) < pmin) return false;
    if (pmax && Number(p.priceMinor ?? Infinity) > pmax) return false;
    if (mode === 'exchange' && !p.exchangeEnabled) return false;
    if (mode === 'rental' && !(p.rentalEnabled && p.paidBookingEnabled)) return false;
    if (bbox.length === 4 && bbox.every(Number.isFinite) && p.location) {
      const [w, s, e, n] = bbox;
      if (p.location.lng < w || p.location.lng > e || p.location.lat < s || p.location.lat > n) return false;
    }
    if (dated) {
      if (!p.rentalEnabled) return false;
      const rec = recordedDays(p.id);
      const booked = locallyBookedNights(p.id);
      const released = locallyReleasedNights(p.id);
      for (const d of dateRange(checkIn, checkOut)) {
        if (booked.has(d)) return false;
        const st = rec.get(d)?.status;
        if (st && st !== 'available' && !released.has(d)) return false;
      }
    }
    return true;
  });
  if (dated) {
    const n = nightsBetween(checkIn, checkOut);
    rows = rows.map((p) => {
      const rec = recordedDays(p.id);
      const nightsTotal = dateRange(checkIn, checkOut).reduce((s, d) => s + Number(rec.get(d)?.priceMinor ?? p.priceMinor ?? 0), 0);
      return { ...p, nights: n, nightsTotalMinor: nightsTotal, totalPriceMinor: nightsTotal, available: true };
    });
  }
  if (sort === 'price_asc') rows.sort((a, b) => Number(a.priceMinor ?? 0) - Number(b.priceMinor ?? 0));
  else if (sort === 'price_desc') rows.sort((a, b) => Number(b.priceMinor ?? 0) - Number(a.priceMinor ?? 0));
  else if (sort === 'rating') rows.sort((a, b) => Number(b.ratingAvg ?? 0) - Number(a.ratingAvg ?? 0));
  const facet = (fn: (p: Obj) => string[]) => rows.reduce((m: Obj, p) => (fn(p).forEach((k) => k && (m[k] = (m[k] ?? 0) + 1)), m), {});
  const total = rows.length;
  return {
    items: rows.slice((page - 1) * limit, page * limit),
    total,
    page,
    limit,
    facets: {
      propertyType: facet((p) => [p.propertyType]),
      amenities: facet((p) => p.amenities ?? []),
      city: facet((p) => [p.city]),
      mode: { rental: rows.filter((p) => p.rentalEnabled).length, exchange: rows.filter((p) => p.exchangeEnabled).length },
    },
    candidatesOnly: true,
    dateFiltered: dated,
  };
}

export function suggest(q: string): Obj {
  const ql = q.trim().toLowerCase();
  const all = catalog();
  const cities = [...new Set(all.map((p) => p.city).filter(Boolean))].filter((c) => matchesQuery({ city: c, title: c }, q) || String(c).toLowerCase().includes(ql));
  const listings = all.filter((p) => matchesQuery(p, q)).slice(0, 5);
  return { items: listings.map((p) => ({ type: 'PROPERTY', id: p.id, label: p.title, city: p.city })), cities, places: [] };
}

// ------------------------------------------------------------------------------------------- pricing
export function feeRates() {
  const t = itemOf(F.templates?.quote);
  const base = Number(t?.subtotalMinor ?? 0) + Number(t?.cleaningFeeMinor ?? 0);
  const platform = base > 0 ? Number(t.platformFeeMinor) / base : 0.1;
  const tax = Number(t?.platformFeeMinor) > 0 ? Number(t.taxMinor) / Number(t.platformFeeMinor) : 0.1;
  const host = base > 0 && t?.breakdown?.hostFeeMinor ? Number(t.breakdown.hostFeeMinor) / base : 0.03;
  return { platform: Number.isFinite(platform) ? platform : 0.1, tax: Number.isFinite(tax) ? tax : 0.1, host };
}

export class QuoteError extends Error {
  constructor(public status: number, public code: string, msg: string, public extra: Obj = {}) {
    super(msg);
  }
}

export function computeQuote(propertyId: string, checkIn: string, checkOut: string, guests: number, guestId: string): Obj {
  const p = propertyDetail(propertyId);
  if (!p) throw new QuoteError(404, 'NOT_FOUND', 'Property not found');
  if (!p.rentalEnabled || p.paidBookingEnabled === false || (p.status && p.status !== 'PUBLISHED')) throw new QuoteError(422, 'PROPERTY_NOT_BOOKABLE', 'Property is not open for paid stays');
  if (hostIdOf(propertyId) === guestId) throw new QuoteError(403, 'SELF_BOOKING', '호스트는 자신의 숙소를 예약할 수 없어요. 게스트 계정으로 바꿔 보세요. / Hosts cannot book their own property.');
  const n = nightsBetween(checkIn, checkOut);
  if (!(n > 0)) throw new QuoteError(400, 'INVALID_RANGE', 'Check-out must be after check-in');
  if (checkIn < today()) throw new QuoteError(400, 'DATE_IN_PAST', 'Check-in date is in the past');
  if (guests < 1 || guests > Number(p.maxGuests || 50)) throw new QuoteError(422, 'MAX_GUESTS_EXCEEDED', `Property allows at most ${p.maxGuests} guests`);
  const minNights = Number(p.minNights || 1);
  if (n < minNights) throw new QuoteError(422, 'MIN_NIGHTS', `Minimum stay is ${minNights} nights`, { minNights });
  if (p.maxNights && n > Number(p.maxNights)) throw new QuoteError(422, 'MAX_NIGHTS', `Maximum stay is ${p.maxNights} nights`, { maxNights: p.maxNights });
  const rec = recordedDays(propertyId);
  const booked = locallyBookedNights(propertyId);
  const released = locallyReleasedNights(propertyId);
  const nights = dateRange(checkIn, checkOut).map((date) => ({ date, priceMinor: Number(rec.get(date)?.priceMinor ?? p.basePriceMinor ?? 0), source: 'BASE', ruleId: null }));
  const closed = nights.filter((x) => booked.has(x.date) || (rec.get(x.date)?.status && rec.get(x.date)!.status !== 'available' && !released.has(x.date))).map((x) => x.date);
  if (closed.length) throw new QuoteError(409, 'DATES_UNAVAILABLE', '선택한 날짜 중 예약할 수 없는 날이 있어요. / Some nights are not available', { dates: closed });
  const r = feeRates();
  const nightsTotalMinor = nights.reduce((s, x) => s + x.priceMinor, 0);
  const cleaningFeeMinor = Number(p.cleaningFeeMinor ?? 0);
  const subtotalMinor = nightsTotalMinor;
  const platformFeeMinor = Math.round((subtotalMinor + cleaningFeeMinor) * r.platform);
  const taxMinor = Math.round(platformFeeMinor * r.tax);
  const hostFeeMinor = Math.round((subtotalMinor + cleaningFeeMinor) * r.host);
  const totalMinor = subtotalMinor + cleaningFeeMinor + platformFeeMinor + taxMinor;
  const tpl = itemOf(F.templates?.quote) ?? {};
  const created = nowIso();
  const breakdown = { ...(tpl.breakdown ?? {}), nightsCount: n, nights, nightsTotalMinor, extraGuestFeeMinor: 0, extraGuest: null, discount: null, discountMinor: 0, subtotalMinor, cleaningFeeMinor, platformFeeMinor, taxMinor, hostFeeMinor, totalMinor, currency: p.currency ?? 'KRW' };
  return {
    ...clone(tpl),
    propertyId,
    guestId,
    checkIn,
    checkOut,
    guests,
    nights: n,
    subtotalMinor,
    cleaningFeeMinor,
    platformFeeMinor,
    taxMinor,
    discountMinor: 0,
    totalMinor,
    currency: p.currency ?? 'KRW',
    breakdown,
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    createdAt: created,
  };
}
