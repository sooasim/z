/**
 * Stateful demo behaviour for the core flows. Every handler returns a Response, or `null` to fall through to
 * the recorded fixtures. Shapes mirror the real API DTOs (apps/api) as captured in the fixtures/templates.
 */
import { F, anyBody, lookup, lookupFor, narrow, userName } from './fixtures';
import { persona, personaByUserId, type Persona } from './auth';
import { QuoteError, catalog, computeQuote, hostIdOf, invalidateCatalog, propertyDetail, publicCalendar, searchItemOf, searchProperties, suggest, locallyBookedNights } from './catalog';
import { S, entities, entity, putEntity, save, type Kind } from './store';
import { publish } from './realtime';
import { addDays, clone, code, dateRange, fld, itemOf, itemsOf, json, nightsBetween, nowIso, problem, today, uuid, type Obj } from './util';

export interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  /** persona key or 'anon' */
  key: string;
  p: Persona | null;
  aal: 'aal1' | 'aal2' | null;
  chain: string[];
  idem: string | null;
  base: string;
}

type Handler = (c: Ctx, ...m: string[]) => Response | null | Promise<Response | null>;
export const routes: Array<[string, RegExp, Handler]> = [];
const on = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);

const ok = (body: unknown) => json(200, body);
const created = (body: unknown) => json(201, body);
const unauth = () => problem(401, 'UNAUTHENTICATED', 'Sign in required');
const notFound = (what = 'Resource') => problem(404, 'NOT_FOUND', `${what} not found`);
const me = (c: Ctx) => c.p?.userId ?? '';
const PERSONAL = /^\/v1\/(reservations|exchanges|guide-bookings|guide-requests|orders|conversations|notifications|favorites|payments|receipts|me\/reviews|itineraries|collections|disputes|support\/cases|privacy\/requests|verifications|host-applications|consents)(\/|$)/;

/** Recorded response for this request (persona chain), or null. */
export function recorded(c: Ctx, path = c.path, query = c.query) {
  const h = lookup(c.chain, path, query);
  if (!h) return null;
  if (h.persona !== c.chain[0] && (h.status === 401 || h.status === 403)) return null;
  return h;
}
/** Recorded list items for this persona (empty for demo sign-ups on personal endpoints). */
function recordedItems(c: Ctx, path: string, query = new URLSearchParams()): Obj[] {
  if (c.p?.custom && PERSONAL.test(path)) return [];
  const h = recorded(c, path, query);
  return h && h.status < 300 ? itemsOf(h.body) : [];
}
/** Recorded detail item for an id, from this persona or any persona that can see it. */
function recordedDetail(c: Ctx, path: string, canSee?: (it: Obj) => boolean): Obj | undefined {
  if (!c.p?.custom) {
    const h = lookupFor(c.key, path, new URLSearchParams());
    if (h && h.status < 300) return itemOf(h.body);
  }
  const b = anyBody(path);
  const it = itemOf(b);
  if (it && (!canSee || canSee(it))) return it;
  return undefined;
}
function personaName(userId: string): string {
  return personaByUserId(userId)?.displayName ?? userName(userId) ?? '회원';
}
function poolId(kind: string): string {
  const s = S();
  const list = F.idPool?.[kind] ?? [];
  const used = new Set(Object.values(S().entities).flatMap((m) => Object.keys(m)));
  for (let i = s.pool[kind] ?? 0; i < list.length; i++) {
    if (!used.has(list[i])) {
      s.pool[kind] = i + 1;
      save();
      return list[i];
    }
  }
  // Pool exhausted: a fresh id still works for API calls, only its detail page is not prerendered.
  return uuid();
}
function notify(userId: string, templateKey: string, title: string, body: string, data: Obj = {}) {
  if (!userId) return;
  const n = { id: uuid(), userId, templateKey, category: 'TRANSACTIONAL', title, body, data, readAt: null, createdAt: nowIso(), demo: true };
  putEntity('notification', n);
  publish([userId], 'notification', { type: 'notification.created', notification: n });
}
function mergeById(local: Obj[], recordedRows: Obj[], kind: Kind): Obj[] {
  const store = S().entities[kind] || {};
  const ids = new Set(local.map((x) => x.id));
  const rows = recordedRows.filter((r) => !ids.has(r.id)).map((r) => (store[r.id] ? { ...r, ...pickState(store[r.id]) } : r));
  return [...local, ...rows];
}
/** Lifecycle fields that a demo mutation may change on a recorded entity. */
function pickState(o: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(o)) if (/status|state|At$|_at$|Reason|reason|refunded|version|nextAction|accepted|current_offer|offers|booking|paid|title/i.test(k)) out[k] = o[k];
  return out;
}

// ============================================================================================ config / me
on('GET', /^\/v1\/config\/public$/, (c) => {
  const h = recorded(c);
  const body = h?.body ?? { flags: {}, config: {} };
  body.config = { ...(body.config ?? {}), paymentProvider: 'MOCK', demo: true, staticDemo: true };
  body.paymentProvider = 'MOCK';
  return ok(body);
});

on('GET', /^\/v1\/me$/, (c) => {
  if (!c.p) return unauth();
  const h = !c.p.custom ? recorded(c) : null;
  const body = h?.status === 200 ? h.body : { user: {}, session: {} };
  const rec = F.personas[c.p.base]?.login?.user ?? {};
  body.user = { ...(body.user ?? {}), ...(c.p.custom ? { ...clone(rec), id: c.p.userId, email: c.p.email, roles: ['USER'], identityVerified: false, linkedProviders: [] } : {}), displayName: c.p.displayName };
  if (S().patches[c.key]?.mfa) body.user.mfaEnabled = !!S().patches[c.key].mfa.enabled;
  if (c.key === 'admin') body.user.mfaEnabled = true;
  const prof = S().patches[c.key]?.profile;
  if (prof) Object.assign(body.user, Object.fromEntries(Object.entries(prof).filter(([k]) => ['displayName', 'phone', 'locale'].includes(k))));
  body.session = { ...(body.session ?? {}), aal: c.aal ?? 'aal1' };
  if (body.aal) body.aal = c.aal;
  return ok(body);
});

const patchable: Record<string, string> = { '/v1/me/profile': 'profile', '/v1/me/preferences': 'preferences', '/v1/notification-preferences': 'notificationPrefs', '/v1/admin/feature-flags': 'flags' };
on('GET', /^\/v1\/(me\/profile|me\/preferences|notification-preferences)$/, (c) => {
  if (!c.p) return unauth();
  const h = recorded(c, c.path) ?? recorded({ ...c, chain: ['guest'] }, c.path);
  const body = h && h.status < 300 ? h.body : { item: {} };
  const patch = S().patches[c.key]?.[patchable[c.path]];
  if (patch) {
    if (body.item && typeof body.item === 'object') Object.assign(body.item, patch);
    else Object.assign(body, patch);
  }
  if (c.p.custom && body.item) Object.assign(body.item, { displayName: c.p.displayName, preferredName: c.p.displayName });
  return ok(body);
});
on('PATCH', /^\/v1\/(me\/profile|me\/preferences|notification-preferences)$/, (c) => {
  if (!c.p) return unauth();
  const k = patchable[c.path];
  const pt = (S().patches[c.key] ||= {});
  pt[k] = { ...(pt[k] ?? {}), ...(c.body ?? {}) };
  save();
  const h = recorded(c, c.path);
  const base = itemOf(h?.body) ?? {};
  return ok({ item: { ...base, ...pt[k], updatedAt: nowIso() } });
});
on('PUT', /^\/v1\/notification-preferences$/, (c) => {
  if (!c.p) return unauth();
  const pt = (S().patches[c.key] ||= {});
  pt.notificationPrefs = { ...(pt.notificationPrefs ?? {}), ...(c.body ?? {}) };
  save();
  return ok({ item: pt.notificationPrefs });
});
on('GET', /^\/v1\/me\/identities$/, (c) => {
  if (!c.p) return unauth();
  const rows = recordedItems(c, c.path);
  const linked: string[] = S().patches[c.key]?.identities?.linked ?? [];
  const have = new Set(rows.map((r) => String(r.provider).toUpperCase()));
  for (const p of linked) if (!have.has(p)) rows.push({ provider: p, email: c.p.email, linkedAt: nowIso(), demo: true });
  return ok({ items: rows });
});
on('DELETE', /^\/v1\/me\/identities\/([^/]+)$/, (c, prov) => {
  const pt = (S().patches[c.key] ||= {});
  pt.identities = { linked: ((pt.identities?.linked as string[]) ?? []).filter((x) => x !== prov.toUpperCase()) };
  save();
  return json(204, undefined);
});

// ============================================================================================ favorites
function favState(c: Ctx) {
  return (S().favorites[c.key] ||= { added: [], removed: [] });
}
function favTarget(type: string, id: string): Obj | null {
  if (type === 'PROPERTY') {
    const p = catalog().find((x) => x.id === id);
    if (p) return { available: true, slug: p.slug, title: p.title, city: p.city, region: p.region, propertyType: p.propertyType, priceMinor: p.priceMinor, currency: p.currency, exchangeEnabled: p.exchangeEnabled, coverUrl: p.coverUrl, ratingAvg: p.ratingAvg, reviewCount: p.reviewCount, location: p.location };
  }
  if (type === 'GUIDE') {
    const g = itemOf(anyBody(`/v1/guides/${id}`));
    if (g) return { available: true, displayName: g.displayName ?? g.display_name, headline: g.headline, city: g.city, guideType: g.guideType ?? g.guide_type };
  }
  if (type === 'TRAVEL_PRODUCT') {
    const t = itemOf(anyBody(`/v1/travel-products/${id}`));
    if (t) return { available: true, title: t.title, city: t.city, slug: t.slug, priceMinor: t.basePriceMinor ?? t.fromPriceMinor, currency: t.currency };
  }
  return null;
}
on('GET', /^\/v1\/favorites$/, (c) => {
  if (!c.p) return unauth();
  const st = favState(c);
  const key = (f: Obj) => `${String(f.targetType).toUpperCase()}:${f.targetId}`;
  const removed = new Set(st.removed);
  const added = st.added.filter((f) => !removed.has(key(f)));
  const addedKeys = new Set(added.map(key));
  let rows = [...added, ...recordedItems(c, '/v1/favorites').filter((f) => !removed.has(key(f)) && !addedKeys.has(key(f)))];
  const t = c.query.get('targetType');
  if (t) rows = rows.filter((f) => String(f.targetType).toUpperCase() === t.toUpperCase());
  return ok({ items: rows, nextCursor: null });
});
on('POST', /^\/v1\/favorites$/, (c) => {
  if (!c.p) return unauth();
  const type = String(c.body?.targetType || '').toUpperCase();
  const id = String(c.body?.targetId || '');
  if (!type || !id) return problem(400, 'VALIDATION_FAILED', 'targetType and targetId are required');
  const st = favState(c);
  const k = `${type}:${id}`;
  st.removed = st.removed.filter((x) => x !== k);
  const item = { targetType: type, targetId: id, createdAt: nowIso(), target: favTarget(type, id) };
  st.added = [item, ...st.added.filter((f) => `${f.targetType}:${f.targetId}` !== k)];
  save();
  return created({ created: true, item: { targetType: type, targetId: id, createdAt: item.createdAt } });
});
on('DELETE', /^\/v1\/favorites\/([^/]+)\/([^/]+)$/, (c, type, id) => {
  if (!c.p) return unauth();
  const st = favState(c);
  const k = `${type.toUpperCase()}:${id}`;
  st.added = st.added.filter((f) => `${String(f.targetType).toUpperCase()}:${f.targetId}` !== k);
  if (!st.removed.includes(k)) st.removed.push(k);
  save();
  return json(204, undefined);
});
on('DELETE', /^\/v1\/favorites$/, (c) => {
  if (!c.p) return unauth();
  const type = String(c.body?.targetType ?? c.query.get('targetType') ?? '').toUpperCase();
  const id = String(c.body?.targetId ?? c.query.get('targetId') ?? '');
  const st = favState(c);
  const k = `${type}:${id}`;
  st.added = st.added.filter((f) => `${String(f.targetType).toUpperCase()}:${f.targetId}` !== k);
  if (!st.removed.includes(k)) st.removed.push(k);
  save();
  return json(204, undefined);
});

// ============================================================================================ search & listings
on('GET', /^\/v1\/search\/properties$/, (c) => ok(searchProperties(c.query)));
on('GET', /^\/v1\/search\/suggest$/, (c) => ok(suggest(c.query.get('q') ?? '')));
on('GET', /^\/v1\/properties\/([^/]+)\/calendar$/, (c, id) => {
  if (!propertyDetail(id)) return notFound('Property');
  return ok(publicCalendar(id, c.query.get('from') ?? today(), c.query.get('to') ?? addDays(today(), 365)));
});
on('GET', /^\/v1\/host\/calendar$/, (c) => {
  if (!c.p) return unauth();
  const pid = c.query.get('propertyId') ?? '';
  const h = recorded(c);
  const body = h && h.status < 300 ? h.body : null;
  const local = entity('property', pid);
  if (!body && !local) return h ? null : notFound('Property');
  const from = c.query.get('from') ?? today();
  const to = c.query.get('to') ?? addDays(from, 180);
  const rec = new Map<string, Obj>((itemOf(body)?.days ?? []).map((d: Obj) => [d.date, d]));
  const byNight = new Map<string, Obj>();
  for (const r of entities('reservation')) if (r.propertyId === pid && ['HELD', 'CONFIRMED', 'CHECKED_IN'].includes(r.status)) for (const d of dateRange(r.checkIn, r.checkOut)) byNight.set(d, r);
  const cancelled = new Map<string, Obj>();
  for (const r of entities('reservation')) if (r.propertyId === pid && /CANCEL|EXPIRED|REFUND/.test(r.status)) for (const d of dateRange(r.checkIn, r.checkOut)) cancelled.set(d, r);
  const price = local?.basePriceMinor ?? propertyDetail(pid)?.basePriceMinor ?? null;
  const days = dateRange(from, to).map((date) => {
    const d = rec.get(date) ?? { date, availability: 'AVAILABLE', priceMinor: price, priceSource: 'BASE', minNights: 1, block: null };
    const r = byNight.get(date);
    if (r) return { ...d, availability: 'BOOKED', block: { type: r.status === 'HELD' ? 'HOLD' : 'RESERVATION', reservation: { id: r.id, code: r.code, status: r.status } } };
    const x = cancelled.get(date);
    if (x && d.block?.reservation?.id === x.id) return { ...d, availability: 'AVAILABLE', block: null };
    return d;
  });
  return ok({ item: { ...(itemOf(body) ?? { propertyId: pid, currency: 'KRW' }), from, to, days } });
});

/**
 * /v1/exchange/homes rows carry no slug/photos, so the web would link /stay/<uuid> (not a prerendered page).
 * Fill them from the catalog so cards link to the listing page and show its photos.
 */
on('GET', /^\/v1\/exchange\/homes$/, (c) => {
  const h = recorded(c);
  if (!h || h.status >= 300) return null;
  const cat = new Map(catalog().map((p) => [p.id, p]));
  const body = clone(h.body);
  body.items = itemsOf(body).map((it: Obj) => {
    const p = cat.get(it.id);
    return p ? { ...p, ...it, slug: it.slug ?? p.slug, coverUrl: it.coverUrl ?? p.coverUrl, photoUrls: it.photoUrls ?? p.photoUrls, location: it.location ?? p.location } : it;
  });
  return ok(body);
});

// ---- host listing management (local drafts)
on('GET', /^\/v1\/host\/properties$/, (c) => {
  if (!c.p) return unauth();
  const h = recorded(c);
  if (h && h.status >= 300) return null;
  const local = entities('property').filter((p) => p.hostId === me(c));
  const rows = recordedItems(c, c.path).map((r) => (entity('property', r.id) ? { ...r, ...entity('property', r.id) } : r));
  const ids = new Set(rows.map((r) => r.id));
  return ok({ ...(h?.body ?? {}), items: [...local.filter((p) => !ids.has(p.id)), ...rows] });
});
on('POST', /^\/v1\/properties$/, (c) => {
  if (!c.p) return unauth();
  const tpl = itemOf(anyBody(`/v1/properties/by-slug/${catalog()[0]?.slug}`)) ?? {};
  const id = poolId('property');
  const b = c.body ?? {};
  const p = {
    ...clone(tpl),
    id,
    hostId: me(c),
    host: { id: me(c), displayName: c.p.displayName },
    slug: `demo-${id.slice(0, 8)}`,
    title: b.title ?? '새 숙소',
    summary: b.summary ?? null,
    description: b.description ?? null,
    propertyType: b.propertyType ?? 'APARTMENT',
    roomType: b.roomType ?? 'ENTIRE',
    maxGuests: b.maxGuests ?? 2,
    bedrooms: b.bedrooms ?? 1,
    beds: b.beds ?? 1,
    bathrooms: b.bathrooms ?? 1,
    rentalEnabled: b.rentalEnabled ?? true,
    exchangeEnabled: b.exchangeEnabled ?? false,
    paidBookingEnabled: false,
    basePriceMinor: b.basePriceMinor ?? 100000,
    cleaningFeeMinor: b.cleaningFeeMinor ?? 0,
    status: 'DRAFT',
    location: { country: b.country ?? 'KR', region: b.region ?? null, city: b.city ?? null, areaLabel: b.city ? `${b.city} 중심가` : null, lat: b.lat ?? null, lng: b.lng ?? null, approximate: true },
    media: (tpl.media ?? []).slice(0, 3),
    reputation: { ratingAvg: null, reviewCount: 0 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    publishedAt: null,
    demo: true,
  };
  putEntity('property', p);
  return created({ item: p });
});
const localProperty = (id: string) => entity('property', id);
on('GET', /^\/v1\/properties\/([0-9a-f-]{36})$/, (c, id) => {
  const p = localProperty(id);
  return p ? ok({ item: p }) : null;
});
on('GET', /^\/v1\/properties\/by-slug\/([^/]+)$/, (c, slug) => {
  const p = entities('property').find((x) => x.slug === decodeURIComponent(slug));
  return p ? ok({ item: p }) : null;
});
on('PATCH', /^\/v1\/properties\/([0-9a-f-]{36})$/, (c, id) => {
  if (!c.p) return unauth();
  const p = localProperty(id) ?? (() => {
    const d = propertyDetail(id);
    return d ? { ...d } : null;
  })();
  if (!p) return notFound('Property');
  const b = c.body ?? {};
  Object.assign(p, b, { updatedAt: nowIso() });
  if (b.city || b.lat) p.location = { ...(p.location ?? {}), ...(b.city ? { city: b.city } : {}), ...(b.lat ? { lat: b.lat, lng: b.lng } : {}) };
  putEntity('property', p);
  invalidateCatalog();
  return ok({ item: p });
});
on('POST', /^\/v1\/properties\/([0-9a-f-]{36})\/(publish|unlist|archive|withdraw)$/, (c, id, action) => {
  if (!c.p) return unauth();
  const p = localProperty(id) ?? propertyDetail(id);
  if (!p) return notFound('Property');
  const status = action === 'publish' ? 'PUBLISHED' : action === 'unlist' ? 'UNLISTED' : action === 'archive' ? 'ARCHIVED' : 'DRAFT';
  Object.assign(p, { status, paidBookingEnabled: action === 'publish' ? !!p.rentalEnabled : p.paidBookingEnabled, publishedAt: action === 'publish' ? nowIso() : p.publishedAt, updatedAt: nowIso() });
  putEntity('property', p);
  invalidateCatalog();
  return ok({ item: p, outcome: status === 'PUBLISHED' ? 'PUBLISHED' : status, compliance: { decision: 'ALLOW', reasons: [], demo: true } });
});
on('PUT', /^\/v1\/properties\/([0-9a-f-]{36})\/(amenities|media|availability)$/, (c, id, what) => {
  if (!c.p) return unauth();
  const p = localProperty(id);
  if (p && what === 'amenities') {
    p.amenities = (c.body?.codes ?? []).map((code: string) => ({ code, labelKo: code, labelEn: code }));
    putEntity('property', p);
  }
  return ok({ item: what === 'amenities' ? p?.amenities ?? c.body?.codes ?? [] : { propertyId: id, ...(c.body ?? {}), demo: true } });
});

// ============================================================================================ booking
on('POST', /^\/v1\/booking\/quotes$/, (c) => {
  if (!c.p) return unauth();
  const b = c.body ?? {};
  try {
    const q = computeQuote(String(b.propertyId), String(b.checkIn), String(b.checkOut), Number(b.guests || 1), me(c));
    q.id = uuid();
    putEntity('quote', q);
    return created({ item: q });
  } catch (e) {
    if (e instanceof QuoteError) return problem(e.status, e.code, e.message, e.extra);
    throw e;
  }
});
on('GET', /^\/v1\/booking\/quotes\/([^/]+)$/, (c, id) => {
  const q = entity('quote', id);
  return q && q.guestId === me(c) ? ok({ item: q }) : notFound('Quote');
});

function reservationTemplate(): Obj {
  return itemOf(F.templates?.hold)?.reservation ?? recordedDetail({ key: 'guest' } as Ctx, `/v1/reservations/${F.ids.reservationIds?.[0]}`) ?? {};
}
function reservationDetailExtras(r: Obj, viewer: string): Obj {
  const d = propertyDetail(r.propertyId);
  const tpl = recordedDetail({ key: 'guest', p: null } as any, `/v1/reservations/${F.ids.reservationIds?.[0]}`) ?? {};
  const prop = d
    ? { ...(tpl.property ?? {}), id: d.id, title: d.title, city: d.location?.city ?? d.city, slug: d.slug, coverUrl: d.media?.[0]?.url ?? d.coverUrl ?? null, address: tpl.property?.address ? { ...tpl.property.address, city: d.location?.city } : undefined }
    : tpl.property;
  return { viewerRole: viewer === r.hostId ? 'HOST' : 'GUEST', property: prop, propertyTitle: d?.title };
}
/**
 * List rows from /v1/reservations and /v1/host/reservations carry ids only; the static demo adds the listing
 * title and the guest's display name (from the recorded catalog) so the tables read naturally.
 */
function enrichRes(r: Obj, viewer: string): Obj {
  const d = propertyDetail(r.propertyId);
  const out: Obj = { ...r };
  if (d && !r.propertyTitle) out.propertyTitle = d.title;
  if (d && !r.property) out.property = { id: d.id, title: d.title, city: d.location?.city ?? d.city, slug: d.slug };
  if (!r.guestName && r.guestId) out.guestName = personaName(r.guestId);
  if (!r.guest && r.guestId) out.guest = { id: r.guestId, displayName: personaName(r.guestId) };
  out.viewerRole = r.hostId === viewer ? 'HOST' : 'GUEST';
  return out;
}
on('POST', /^\/v1\/booking\/holds$/, (c) => {
  if (!c.p) return unauth();
  const q = entity('quote', String(c.body?.quoteId || ''));
  if (!q || q.guestId !== me(c)) return notFound('Quote');
  if (Date.parse(q.expiresAt) < Date.now()) return problem(410, 'QUOTE_EXPIRED', 'The quote has expired; request a new quote');
  if (entities('hold').some((h) => h.quoteId === q.id && h.status === 'ACTIVE')) return problem(409, 'HOLD_EXISTS', 'This quote already has an active hold');
  const busy = locallyBookedNights(q.propertyId);
  if (dateRange(q.checkIn, q.checkOut).some((d) => busy.has(d))) return problem(409, 'INVENTORY_UNAVAILABLE', 'The requested dates are no longer available');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  const hold = { id: uuid(), quoteId: q.id, propertyId: q.propertyId, inventoryBlockId: uuid(), guestId: me(c), status: 'ACTIVE', expiresAt, createdAt: now };
  putEntity('hold', hold);
  const d = propertyDetail(q.propertyId);
  const tpl = reservationTemplate();
  const r = {
    ...clone(tpl),
    id: poolId('reservation'),
    code: code(10),
    propertyId: q.propertyId,
    hostId: hostIdOf(q.propertyId) ?? tpl.hostId,
    guestId: me(c),
    holdId: hold.id,
    quoteId: q.id,
    status: 'HELD',
    checkIn: q.checkIn,
    checkOut: q.checkOut,
    guests: q.guests,
    totalMinor: q.totalMinor,
    refundedMinor: 0,
    currency: q.currency,
    quote: clone(q),
    cancellationPolicy: d?.cancellationPolicy ? { ...clone(tpl.cancellationPolicy ?? {}), ...d.cancellationPolicy, capturedAt: now } : tpl.cancellationPolicy,
    cancelledAt: null,
    cancelReason: null,
    confirmedAt: null,
    checkedInAt: null,
    completedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    holdExpiresAt: expiresAt,
    demo: true,
  };
  putEntity('reservation', r);
  return created({ item: { hold, reservation: r } });
});
on('DELETE', /^\/v1\/booking\/holds\/([^/]+)$/, (c, id) => {
  const h = entity('hold', id);
  if (!h) return notFound('Hold');
  h.status = 'RELEASED';
  putEntity('hold', h);
  const r = entities('reservation').find((x) => x.holdId === id);
  if (r && r.status === 'HELD') putEntity('reservation', { ...r, status: 'EXPIRED', updatedAt: nowIso() });
  return json(204, undefined);
});

function getReservation(c: Ctx, id: string): Obj | undefined {
  const local = entity('reservation', id);
  const rec = recordedDetail(c, `/v1/reservations/${id}`, (it) => it.guestId === me(c) || it.hostId === me(c));
  if (local && rec) return { ...rec, ...local };
  return local ?? rec;
}
function visibleRes(c: Ctx, r: Obj) {
  return r.guestId === me(c) || r.hostId === me(c) || c.key === 'admin';
}
on('GET', /^\/v1\/reservations$/, (c) => {
  if (!c.p) return unauth();
  const local = entities('reservation').filter((r) => r.guestId === me(c) && !(r.status === 'HELD' && Date.parse(r.holdExpiresAt ?? '') < Date.now()));
  let rows = mergeById(local, recordedItems(c, '/v1/reservations', new URLSearchParams()), 'reservation').map((r) => enrichRes(r, me(c)));
  const st = c.query.get('status');
  if (st) rows = rows.filter((r) => r.status === st);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return ok({ items: rows, nextCursor: null });
});
on('GET', /^\/v1\/host\/reservations$/, (c) => {
  if (!c.p) return unauth();
  const h = recorded(c);
  if (h && h.status >= 300) return null;
  const filter = c.query.get('filter');
  const t = today();
  const keep = (r: Obj) => {
    if (r.status === 'HELD') return false;
    if (!filter) return true;
    if (filter === 'cancelled') return /CANCEL|REFUND/.test(r.status);
    if (filter === 'completed') return r.status === 'COMPLETED';
    if (filter === 'current') return r.status === 'CHECKED_IN' || (r.checkIn <= t && r.checkOut > t && r.status === 'CONFIRMED');
    return r.checkIn >= t && ['CONFIRMED', 'PAYMENT_PENDING'].includes(r.status);
  };
  const local = entities('reservation').filter((r) => r.hostId === me(c));
  const rows = mergeById(local, recordedItems(c, '/v1/host/reservations', c.query), 'reservation').filter(keep).map((r) => enrichRes(r, me(c)));
  return ok({ items: rows, nextCursor: null });
});
on('GET', /^\/v1\/reservations\/([^/]+)$/, (c, id) => {
  if (!c.p) return unauth();
  const r = getReservation(c, id);
  if (!r || !visibleRes(c, r)) return notFound('Reservation');
  return ok({ item: { ...r, ...(entity('reservation', id) ? reservationDetailExtras(r, me(c)) : {}), viewerRole: r.hostId === me(c) ? 'HOST' : 'GUEST' } });
});
function cancellationEval(r: Obj, actorRole: string): Obj {
  const tiers: Obj[] = r.cancellationPolicy?.tiers ?? [{ refund_pct: 100, min_hours_before: 120 }, { refund_pct: 50, min_hours_before: 24 }, { refund_pct: 0, min_hours_before: 0 }];
  const checkInAt = new Date(`${r.checkIn}T${(r.cancellationPolicy?.checkInTime ?? '15:00:00').slice(0, 8)}+09:00`);
  const hours = Math.round(((checkInAt.getTime() - Date.now()) / 3600000) * 100) / 100;
  const tier = [...tiers].sort((a, b) => b.min_hours_before - a.min_hours_before).find((t) => hours >= t.min_hours_before) ?? tiers[tiers.length - 1];
  const pct = actorRole === 'HOST' ? 100 : Number(tier?.refund_pct ?? 0);
  const platformFeeMinor = Number(r.quote?.platformFeeMinor ?? 0) + Number(r.quote?.taxMinor ?? 0);
  const feeRefundable = actorRole === 'HOST' || !!r.cancellationPolicy?.service_fee_refundable;
  const base = Number(r.totalMinor) - Number(r.refundedMinor ?? 0) - (feeRefundable ? 0 : platformFeeMinor);
  const refundMinor = Math.max(0, Math.round((base * pct) / 100));
  return {
    actorRole,
    policyCode: r.cancellationPolicy?.code ?? 'MODERATE',
    hoursBeforeCheckIn: hours,
    checkInAt: checkInAt.toISOString(),
    timezone: 'Asia/Seoul',
    tier,
    refundPct: pct,
    serviceFeeRefundable: feeRefundable,
    totalMinor: r.totalMinor,
    alreadyRefundedMinor: r.refundedMinor ?? 0,
    platformFeeMinor,
    refundableBaseMinor: base,
    refundMinor,
    nonRefundableMinor: Number(r.totalMinor) - refundMinor,
    currency: r.currency ?? 'KRW',
    basis: actorRole === 'HOST' ? 'HOST_CANCELLATION' : 'GUEST_POLICY',
    evaluatedAt: nowIso(),
  };
}
on('GET', /^\/v1\/reservations\/([^/]+)\/cancellation-preview$/, (c, id) => {
  if (!c.p) return unauth();
  const r = getReservation(c, id);
  if (!r || !visibleRes(c, r)) return notFound('Reservation');
  const cancellable = r.status === 'CONFIRMED';
  return ok({ item: { reservationId: id, status: r.status, cancellable, evaluation: cancellationEval(r, r.hostId === me(c) ? 'HOST' : 'GUEST') } });
});
on('POST', /^\/v1\/reservations\/([^/]+)\/(cancel|check-in|complete|no-show)$/, (c, id, action) => {
  if (!c.p) return unauth();
  const r = getReservation(c, id);
  if (!r || !visibleRes(c, r)) return notFound('Reservation');
  const now = nowIso();
  const next: Obj = { ...r, version: Number(r.version ?? 1) + 1, updatedAt: now };
  if (action === 'cancel') {
    if (r.status !== 'CONFIRMED') return problem(409, 'INVALID_STATE_TRANSITION', `Reservation is ${r.status}; only CONFIRMED stays can be cancelled`);
    const ev = cancellationEval(r, r.hostId === me(c) ? 'HOST' : 'GUEST');
    // Real API: CONFIRMED → CANCELLED → REFUND_PENDING → (PARTIALLY_)REFUNDED once the PG refund settles.
    const refunded = Number(r.refundedMinor ?? 0) + ev.refundMinor;
    const status = ev.refundMinor <= 0 ? 'CANCELLED' : refunded >= Number(r.totalMinor) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    Object.assign(next, { status, cancelledAt: now, cancelReason: c.body?.reason ?? 'demo', refundedMinor: refunded, cancelledBy: r.hostId === me(c) ? 'HOST' : 'GUEST' });
    putEntity('reservation', next);
    const pay = entities('payment').find((p) => p.subjectId === id && p.status === 'APPROVED');
    if (pay && ev.refundMinor > 0) putEntity('payment', { ...pay, refundedMinor: ev.refundMinor, status: ev.refundMinor >= pay.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED', updatedAt: now });
    notify(r.guestId, 'reservation.cancelled', '예약이 취소되었습니다', `환불 예정 금액 ${ev.refundMinor.toLocaleString()}원 (데모)`, { reservationId: id });
    if (r.hostId !== me(c)) notify(r.hostId, 'reservation.cancelled.host', '게스트가 예약을 취소했습니다', `${r.checkIn} ~ ${r.checkOut}`, { reservationId: id });
    return ok({ item: { ...next, cancellation: ev } });
  }
  const map: Obj = { 'check-in': ['CHECKED_IN', 'checkedInAt'], complete: ['COMPLETED', 'completedAt'], 'no-show': ['NO_SHOW', 'completedAt'] };
  const [status, field] = map[action];
  Object.assign(next, { status, [field]: now });
  putEntity('reservation', next);
  return ok({ item: next });
});

// ============================================================================================ payments
function subjectOf(c: Ctx, type: string, id: string): { amount: number; currency: string; name: string; owner: string } | null {
  if (type === 'RESERVATION') {
    const r = getReservation(c, id);
    if (!r) return null;
    const d = propertyDetail(r.propertyId);
    return { amount: Number(r.totalMinor), currency: r.currency ?? 'KRW', name: `${d?.title ?? '숙소'} ${r.checkIn}~${r.checkOut}`, owner: r.guestId };
  }
  if (type === 'ORDER') {
    const o = getOrder(c, id);
    return o ? { amount: Number(o.totalMinor), currency: o.currency ?? 'KRW', name: o.items?.[0]?.title ?? '여행 상품', owner: o.buyerId } : null;
  }
  if (type === 'GUIDE_BOOKING') {
    const b = getGuideBooking(c, id);
    return b ? { amount: Number(b.price_minor ?? b.priceMinor ?? 0), currency: b.currency ?? 'KRW', name: `가이드 ${personaName(b.guide_id ?? b.guideId)}`, owner: b.traveler_id ?? b.travelerId } : null;
  }
  return null;
}
on('POST', /^\/v1\/payments\/toss\/prepare$/, (c) => {
  if (!c.p) return unauth();
  const type = String(c.body?.subjectType || '').toUpperCase();
  const id = String(c.body?.subjectId || '');
  const s = subjectOf(c, type, id);
  if (!s || s.owner !== me(c)) return notFound('Payment subject');
  if (s.amount <= 0) return problem(422, 'NOTHING_TO_PAY', 'This booking is free');
  const existing = entities('payment').find((p) => p.subjectId === id && p.status === 'READY');
  const now = nowIso();
  const tpl = itemOf(F.templates?.confirm) ?? {};
  const pay = existing ?? {
    ...clone(tpl),
    id: uuid(),
    provider: 'MOCK',
    orderId: 'JPD' + code(12),
    paymentKey: null,
    payerId: me(c),
    subjectType: type,
    subjectId: id,
    status: 'READY',
    amountMinor: s.amount,
    refundedMinor: 0,
    currency: s.currency,
    orderName: s.name.slice(0, 100),
    method: null,
    providerStatus: 'READY',
    receiptUrl: null,
    failureCode: null,
    failureMessage: null,
    approvedAt: null,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  putEntity('payment', pay);
  if (type === 'RESERVATION') {
    const r = getReservation(c, id);
    if (r && r.status === 'HELD') putEntity('reservation', { ...r, status: 'PAYMENT_PENDING', updatedAt: now });
  }
  const web = `${location.origin}${c.base}`;
  return created({ paymentId: pay.id, orderId: pay.orderId, amount: pay.amountMinor, currency: pay.currency, orderName: pay.orderName, provider: 'MOCK', clientKey: 'mock_client_key', customerKey: `JPU_${me(c)}`, successUrl: `${web}/checkout/success/?paymentId=${pay.id}`, failUrl: `${web}/checkout/fail/?paymentId=${pay.id}`, expiresAt: pay.expiresAt });
});
on('POST', /^\/v1\/payments\/toss\/confirm$/, (c) => {
  if (!c.p) return unauth();
  const { orderId, paymentKey, amount } = c.body ?? {};
  const pay = entities('payment').find((p) => p.orderId === orderId);
  if (!pay) {
    // A recorded (already approved) payment being re-confirmed: replay it.
    const rec = recordedItems(c, '/v1/payments').find((p) => p.orderId === orderId);
    return rec ? ok({ item: rec }) : notFound('Payment');
  }
  if (pay.status === 'APPROVED') return ok({ item: pay });
  if (Number(amount) !== Number(pay.amountMinor)) {
    putEntity('payment', { ...pay, status: 'FAILED', failureCode: 'AMOUNT_MISMATCH', updatedAt: nowIso() });
    return json(402, { item: pay, code: 'PAYMENT_FAILED', providerCode: 'AMOUNT_MISMATCH', message: 'Amount mismatch' });
  }
  const now = nowIso();
  const done = { ...pay, status: 'APPROVED', paymentKey, method: 'CARD', providerStatus: 'DONE', receiptUrl: null, approvedAt: now, updatedAt: now };
  putEntity('payment', done);
  if (pay.subjectType === 'RESERVATION') {
    const r = getReservation(c, pay.subjectId);
    if (r) {
      const conv = ensureConversation('RESERVATION', r.id, [
        { userId: r.guestId, role: 'GUEST' },
        { userId: r.hostId, role: 'HOST' },
      ]);
      putEntity('reservation', { ...r, status: 'CONFIRMED', confirmedAt: now, updatedAt: now, version: Number(r.version ?? 1) + 2, conversationId: conv.id });
      const title = propertyDetail(r.propertyId)?.title ?? '숙소';
      notify(r.guestId, 'reservation.confirmed.guest', '예약이 확정되었습니다', `${title} · ${r.checkIn} ~ ${r.checkOut}`, { reservationId: r.id });
      notify(r.hostId, 'reservation.confirmed.host', '새 예약이 확정되었습니다', `${personaName(r.guestId)} · ${title} · ${r.checkIn} ~ ${r.checkOut}`, { reservationId: r.id });
    }
  } else if (pay.subjectType === 'ORDER') {
    const o = getOrder(c, pay.subjectId);
    if (o) {
      putEntity('order', { ...o, status: 'PAID', updatedAt: now, items: (o.items ?? []).map((it: Obj) => ({ ...it, vouchers: Array.from({ length: Number(it.qty || 1) }, () => ({ code: 'TV' + code(12), status: 'ISSUED' })) })) });
      notify(o.buyerId, 'order.paid', '여행 상품 예약이 확정되었습니다', o.items?.[0]?.title ?? '', { orderId: o.id });
    }
  } else if (pay.subjectType === 'GUIDE_BOOKING') {
    const b = getGuideBooking(c, pay.subjectId);
    if (b) {
      putEntity('guideBooking', { ...b, status: 'CONFIRMED', updated_at: now, history: [...(b.history ?? []), { from_state: b.status, to_state: 'CONFIRMED', actor_type: 'SYSTEM', reason: 'payment approved (demo)', created_at: now }] });
      notify(b.traveler_id, 'guide.booking.confirmed', '가이드 일정이 확정되었습니다', personaName(b.guide_id), { bookingId: b.id });
      notify(b.guide_id, 'guide.booking.confirmed', '가이드 예약이 결제되었습니다', personaName(b.traveler_id), { bookingId: b.id });
    }
  }
  notify(me(c), 'payment.approved', '결제가 완료되었습니다', `${pay.orderName} · ${Number(pay.amountMinor).toLocaleString()}원 (테스트 결제)`, { paymentId: pay.id });
  return ok({ item: done });
});
on('GET', /^\/v1\/payments$/, (c) => {
  if (!c.p) return unauth();
  const local = entities('payment').filter((p) => p.payerId === me(c));
  let rows = mergeById(local, recordedItems(c, '/v1/payments'), 'payment');
  const oid = c.query.get('orderId');
  if (oid) rows = rows.filter((p) => p.orderId === oid);
  return ok({ items: rows, nextCursor: null });
});
on('GET', /^\/v1\/payments\/([^/]+)$/, (c, id) => {
  if (!c.p) return unauth();
  const p = entity('payment', id) ?? recordedDetail(c, `/v1/payments/${id}`);
  return p ? ok({ item: p }) : notFound('Payment');
});
on('GET', /^\/v1\/payments\/([^/]+)\/refunds$/, (c, id) => {
  const p = entity('payment', id);
  if (!p) return null;
  return ok({ items: p.refundedMinor ? [{ id: uuid(), paymentId: id, amountMinor: p.refundedMinor, status: 'SUCCEEDED', reason: 'demo cancellation', createdAt: p.updatedAt }] : [] });
});

// ============================================================================================ messaging
function ensureConversation(contextType: string, contextId: string, members: Array<{ userId: string; role: string }>): Obj {
  const ex = entities('conversation').find((x) => x.contextType === contextType && x.contextId === contextId);
  if (ex) return ex;
  const conv = {
    id: poolId('conversation'),
    contextType,
    contextId,
    status: 'OPEN',
    muted: false,
    members: members.filter((m) => m.userId).map((m) => ({ ...m, displayName: personaName(m.userId) })),
    createdAt: nowIso(),
    demo: true,
  };
  return putEntity('conversation', conv);
}
function messagesOf(cid: string): Obj[] {
  return S().messages[cid] ?? [];
}
function addMessage(cid: string, senderId: string, body: string, clientMessageId?: string): Obj {
  const m = { id: uuid(), conversationId: cid, senderId, type: 'TEXT', body, mediaId: null, clientMessageId: clientMessageId ?? null, redacted: false, metadata: {}, createdAt: nowIso() };
  (S().messages[cid] ||= []).push(m);
  save();
  return m;
}
function convMembers(c: Ctx, cid: string): Obj[] {
  const local = entity('conversation', cid);
  if (local) return local.members ?? [];
  for (const k of [c.key, ...Object.keys(F.personas)]) {
    const h = lookupFor(k, '/v1/conversations', new URLSearchParams());
    const conv = itemsOf(h?.body).find((x) => x.id === cid);
    if (conv) return conv.members ?? [];
  }
  return [];
}
function decorateConv(c: Ctx, conv: Obj): Obj {
  const local = messagesOf(conv.id);
  const last = local[local.length - 1];
  const readAt = S().read.conversations[`${c.key}|${conv.id}`];
  const unreadLocal = local.filter((m) => m.senderId !== me(c) && (!readAt || m.createdAt > readAt)).length;
  const myRole = conv.members?.find((m: Obj) => m.userId === me(c))?.role ?? conv.myRole;
  return {
    ...conv,
    myRole,
    unreadCount: readAt ? unreadLocal : Number(conv.unreadCount ?? 0) + unreadLocal,
    ...(last ? { lastMessage: { id: last.id, senderId: last.senderId, type: 'TEXT', body: last.body, createdAt: last.createdAt }, lastMessageAt: last.createdAt } : {}),
  };
}
on('GET', /^\/v1\/conversations$/, (c) => {
  if (!c.p) return unauth();
  const local = entities('conversation').filter((x) => x.members?.some((m: Obj) => m.userId === me(c)));
  const rows = mergeById(local, recordedItems(c, '/v1/conversations'), 'conversation').map((x) => decorateConv(c, x));
  rows.sort((a, b) => String(b.lastMessageAt ?? b.createdAt).localeCompare(String(a.lastMessageAt ?? a.createdAt)));
  return ok({ items: rows, nextCursor: null });
});
on('POST', /^\/v1\/conversations$/, (c) => {
  if (!c.p) return unauth();
  const b = c.body ?? {};
  const targetType = String(b.targetType || 'PROPERTY').toUpperCase();
  const targetId = String(b.targetId || '');
  const otherId = targetType === 'GUIDE' ? targetId : hostIdOf(targetId) ?? '';
  if (otherId === me(c)) return problem(422, 'SELF_CONVERSATION', '자기 자신에게는 문의할 수 없어요.');
  const conv =
    entities('conversation').find((x) => x.contextType === 'INQUIRY' && x.targetId === targetId && x.members?.some((m: Obj) => m.userId === me(c))) ??
    putEntity('conversation', {
      ...ensureConversation('INQUIRY', uuid(), [
        { userId: me(c), role: targetType === 'GUIDE' ? 'TRAVELER' : 'GUEST' },
        { userId: otherId, role: targetType === 'GUIDE' ? 'GUIDE' : 'HOST' },
      ]),
      targetType,
      targetId,
    });
  const msg = b.message ? addMessage(conv.id, me(c), String(b.message), b.clientMessageId) : null;
  if (msg) scheduleReply(c, conv.id, String(b.message));
  return created({ item: { id: conv.id }, message: msg });
});
on('GET', /^\/v1\/conversations\/([^/]+)\/messages$/, (c, cid) => {
  if (!c.p) return unauth();
  const members = convMembers(c, cid);
  if (!members.some((m) => m.userId === me(c)) && c.key !== 'admin') return notFound('Conversation');
  const h = recorded(c, `/v1/conversations/${cid}/messages`, new URLSearchParams());
  const rec = h && h.status < 300 ? itemsOf(h.body) : [];
  const rows = [...rec, ...messagesOf(cid)].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return ok({ items: rows, nextCursor: null });
});
const REPLIES = [
  '메시지 감사합니다! 확인하고 곧 자세히 답변드릴게요 :) (데모 자동 응답)',
  '좋아요! 그 날짜에 맞춰 준비해 둘게요. 궁금한 점 있으면 언제든 물어보세요. (데모 자동 응답)',
  'Thanks for reaching out — happy to help! (demo auto-reply)',
];
function scheduleReply(c: Ctx, cid: string, text: string) {
  const members = convMembers(c, cid);
  const other = members.find((m) => m.userId && m.userId !== me(c));
  if (!other) return;
  const mine = messagesOf(cid).filter((m) => m.senderId === me(c)).length;
  if (mine > 3) return;
  const myId = me(c);
  setTimeout(() => {
    const reply = addMessage(cid, other.userId, REPLIES[(mine - 1 + REPLIES.length) % REPLIES.length] ?? REPLIES[0]);
    publish([myId], 'message.created', { type: 'message.created', conversationId: cid, message: reply });
    notify(myId, 'message.received', '새 메시지 / New message', `${personaName(other.userId)}님이 메시지를 보냈습니다.`, { conversationId: cid, senderName: personaName(other.userId) });
  }, 1600 + Math.min(2000, text.length * 20));
}
on('POST', /^\/v1\/conversations\/([^/]+)\/messages$/, (c, cid) => {
  if (!c.p) return unauth();
  const members = convMembers(c, cid);
  if (!members.some((m) => m.userId === me(c))) return notFound('Conversation');
  const body = String(c.body?.body ?? '').trim();
  if (!body) return problem(400, 'VALIDATION_FAILED', 'Message body is required');
  const m = addMessage(cid, me(c), body, c.body?.clientMessageId);
  publish(members.map((x) => x.userId).filter((u) => u !== me(c)), 'message.created', { type: 'message.created', conversationId: cid, message: m });
  scheduleReply(c, cid, body);
  return created({ item: m, replayed: false });
});
on('POST', /^\/v1\/conversations\/([^/]+)\/read$/, (c, cid) => {
  if (!c.p) return unauth();
  S().read.conversations[`${c.key}|${cid}`] = nowIso();
  save();
  return ok({ item: { conversationId: cid, readAt: nowIso() } });
});
on('POST', /^\/v1\/messages\/([^/]+)\/report$/, () => created({ item: { id: uuid(), status: 'RECEIVED', demo: true } }));

// ============================================================================================ notifications
on('GET', /^\/v1\/notifications$/, (c) => {
  if (!c.p) return unauth();
  const all = S().read.allBefore[c.key];
  const isRead = (n: Obj) => !!n.readAt || !!S().read.notifications[n.id] || (!!all && String(n.createdAt) <= all);
  const local = entities('notification').filter((n) => n.userId === me(c));
  let rows = [...local, ...recordedItems(c, '/v1/notifications')].map((n) => (isRead(n) && !n.readAt ? { ...n, readAt: S().read.notifications[n.id] ?? all } : n));
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const unreadCount = rows.filter((n) => !n.readAt).length;
  if (c.query.get('unread') === 'true') rows = rows.filter((n) => !n.readAt);
  const limit = Number(c.query.get('limit') || 0);
  if (limit > 0) rows = rows.slice(0, limit);
  return ok({ items: rows, nextCursor: null, unreadCount });
});
on('POST', /^\/v1\/notifications\/read-all$/, (c) => {
  if (!c.p) return unauth();
  S().read.allBefore[c.key] = nowIso();
  save();
  return ok({ updated: true });
});
on('POST', /^\/v1\/notifications\/([^/]+)\/read$/, (c, id) => {
  if (!c.p) return unauth();
  S().read.notifications[id] = nowIso();
  save();
  return ok({ item: { id, readAt: nowIso() } });
});

// ============================================================================================ exchanges
function getExchange(c: Ctx, id: string): Obj | undefined {
  const local = entity('exchange', id);
  if (local) return local;
  for (const k of [c.key, 'exchange', 'host', ...Object.keys(F.personas)]) {
    const h = lookupFor(k, `/v1/exchanges/${id}`, new URLSearchParams());
    if (h && h.status < 300) return itemOf(h.body);
  }
  return undefined;
}
function exView(c: Ctx, x: Obj): Obj {
  const mine = me(c);
  const role = x.requesterId === mine ? 'REQUESTER' : 'RESPONDER';
  const party = (uid: string, type: string) => (x.verifications ?? []).some((v: Obj) => v.partyUserId === uid && v.checkType === type && v.status === 'PASSED');
  const signedBy = (uid: string) => !!x.agreement?.signatures?.[uid === x.requesterId ? 'requester' : 'responder'];
  let nextAction: string | null = null;
  switch (x.status) {
    case 'REQUESTED':
    case 'COUNTERED':
      nextAction = x.lastOfferBy === mine ? 'AWAIT_RESPONSE' : 'RESPOND';
      break;
    case 'VERIFICATION_PENDING':
      nextAction = party(mine, 'SAFETY_ACK') ? 'AWAIT_VERIFICATION' : 'SAFETY_ACK';
      break;
    case 'AGREEMENT_PENDING':
      nextAction = signedBy(mine) ? 'AWAIT_COUNTERPARTY_SIGNATURE' : 'SIGN_AGREEMENT';
      break;
    case 'CONFIRMED':
      nextAction = 'PREPARE_TRIP';
      break;
    case 'IN_PROGRESS':
      nextAction = 'COMPLETE_AFTER_STAY';
      break;
    case 'COMPLETED':
      nextAction = 'LEAVE_REVIEW';
      break;
  }
  return { ...x, role, nextAction };
}
function saveExchange(x: Obj): Obj {
  x.updatedAt = nowIso();
  return putEntity('exchange', x);
}
const counterpart = (c: Ctx, x: Obj) => (x.requesterId === me(c) ? x.responderId : x.requesterId);
on('GET', /^\/v1\/exchanges$/, (c) => {
  if (!c.p) return unauth();
  const local = entities('exchange').filter((x) => x.requesterId === me(c) || x.responderId === me(c));
  let rows = mergeById(local, recordedItems(c, '/v1/exchanges'), 'exchange').map((x) => exView(c, entity('exchange', x.id) ?? x));
  const st = c.query.get('status');
  if (st) rows = rows.filter((x) => x.status === st);
  rows.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
  return ok({ items: rows, nextCursor: null });
});
on('GET', /^\/v1\/exchanges\/([^/]+)$/, (c, id) => {
  if (!c.p) return unauth();
  const x = getExchange(c, id);
  if (!x || (x.requesterId !== me(c) && x.responderId !== me(c) && c.key !== 'admin')) return notFound('Exchange');
  return ok({ item: exView(c, x) });
});
on('POST', /^\/v1\/exchanges$/, (c) => {
  if (!c.p) return unauth();
  const b = c.body ?? {};
  const mineP = propertyDetail(String(b.myPropertyId || ''));
  const theirs = propertyDetail(String(b.theirPropertyId || ''));
  if (!mineP || !theirs) return notFound('Property');
  if (hostIdOf(mineP.id) !== me(c)) return problem(422, 'NOT_ELIGIBLE', '맞교환은 내 집을 등록한 회원만 제안할 수 있어요. "맞교환 회원" 페르소나로 바꿔 보세요.', { details: { unmet: ['NO_EXCHANGE_HOME'] } });
  const responderId = hostIdOf(theirs.id)!;
  if (responderId === me(c)) return problem(422, 'SELF_EXCHANGE', 'Cannot exchange with yourself');
  const now = nowIso();
  const offer = { version: 1, createdBy: me(c), datesA: b.datesA, datesB: b.datesB, guestsA: b.guestsA ?? 1, guestsB: b.guestsB ?? 1, terms: b.terms ?? {}, message: b.message ?? null, createdAt: now };
  const id = poolId('exchange');
  const conv = ensureConversation('EXCHANGE', id, [
    { userId: me(c), role: 'REQUESTER' },
    { userId: responderId, role: 'RESPONDER' },
  ]);
  const x = saveExchange({
    id,
    status: 'REQUESTED',
    requesterId: me(c),
    responderId,
    propertyA: { id: mineP.id, title: mineP.title, city: mineP.location?.city ?? mineP.city },
    propertyB: { id: theirs.id, title: theirs.title, city: theirs.location?.city ?? theirs.city },
    datesA: b.datesA,
    datesB: b.datesB,
    currentOfferVersion: 1,
    lastOfferBy: me(c),
    respondBy: new Date(Date.now() + 7 * 86400000).toISOString(),
    conversationId: conv.id,
    createdAt: now,
    requester: { id: me(c), displayName: c.p.displayName },
    responder: { id: responderId, displayName: personaName(responderId) },
    acceptedAVersion: 1,
    acceptedBVersion: null,
    currentOffer: offer,
    offers: [offer],
    verifications: [],
    agreement: null,
    addresses: null,
    confirmedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    version: 1,
    demo: true,
  });
  if (b.message) addMessage(conv.id, me(c), String(b.message));
  notify(responderId, 'exchange.requested', '새 맞교환 제안이 도착했습니다', `${c.p.displayName} · ${mineP.title} ⇄ ${theirs.title}`, { exchangeId: id });
  return created({ item: exView(c, x) });
});
on('POST', /^\/v1\/exchanges\/([^/]+)\/(counter|accept|decline|withdraw|safety-ack|verify|confirm|cancel|complete|dispute)$/, (c, id, action) => {
  if (!c.p) return unauth();
  const x0 = getExchange(c, id);
  if (!x0 || (x0.requesterId !== me(c) && x0.responderId !== me(c))) return notFound('Exchange');
  const x = clone(x0);
  const now = nowIso();
  const isReq = x.requesterId === me(c);
  const bad = (expected: string) => problem(409, 'INVALID_STATE_TRANSITION', `Exchange is ${x.status}, expected ${expected}`, { details: { from: x.status } });
  const b = c.body ?? {};
  switch (action) {
    case 'counter': {
      if (!['REQUESTED', 'COUNTERED'].includes(x.status)) return bad('REQUESTED|COUNTERED');
      if (b.expectedVersion && Number(b.expectedVersion) !== Number(x.currentOfferVersion)) return problem(409, 'STALE_OFFER', 'Terms changed — reload and try again');
      const v = Number(x.currentOfferVersion) + 1;
      const prev = x.currentOffer ?? {};
      const offer = { version: v, createdBy: me(c), datesA: b.datesA ?? prev.datesA, datesB: b.datesB ?? prev.datesB, guestsA: b.guestsA ?? prev.guestsA, guestsB: b.guestsB ?? prev.guestsB, terms: b.terms ?? prev.terms ?? {}, message: b.message ?? null, createdAt: now };
      Object.assign(x, { status: 'COUNTERED', currentOfferVersion: v, version: v, lastOfferBy: me(c), currentOffer: offer, offers: [...(x.offers ?? []), offer], datesA: offer.datesA, datesB: offer.datesB, acceptedAVersion: isReq ? v : null, acceptedBVersion: isReq ? null : v });
      notify(counterpart(c, x), 'exchange.countered', '맞교환 조건이 변경되었습니다', `v${v} 제안을 확인해 주세요`, { exchangeId: id });
      break;
    }
    case 'accept': {
      if (!['REQUESTED', 'COUNTERED'].includes(x.status)) return bad('REQUESTED|COUNTERED');
      if (b.offerVersion && Number(b.offerVersion) !== Number(x.currentOfferVersion)) return problem(409, 'STALE_OFFER', 'Terms changed — reload and try again');
      if (isReq) x.acceptedAVersion = x.currentOfferVersion;
      else x.acceptedBVersion = x.currentOfferVersion;
      if (x.acceptedAVersion === x.currentOfferVersion && x.acceptedBVersion === x.currentOfferVersion) {
        x.status = 'VERIFICATION_PENDING';
        notify(counterpart(c, x), 'exchange.accepted', '맞교환 제안이 수락되었습니다', '안전 수칙 확인 후 계약서 서명이 진행됩니다', { exchangeId: id });
      }
      break;
    }
    case 'decline':
    case 'withdraw':
      if (!['REQUESTED', 'COUNTERED'].includes(x.status)) return bad('REQUESTED|COUNTERED');
      x.status = action === 'decline' ? 'DECLINED' : 'WITHDRAWN';
      x.cancelledAt = now;
      notify(counterpart(c, x), `exchange.${action}`, action === 'decline' ? '맞교환 제안이 거절되었습니다' : '맞교환 제안이 철회되었습니다', '', { exchangeId: id });
      break;
    case 'safety-ack':
    case 'verify': {
      if (x.status !== 'VERIFICATION_PENDING') return bad('VERIFICATION_PENDING');
      const prop = isReq ? x.propertyA?.id : x.propertyB?.id;
      const add = (checkType: string, detail: Obj) => {
        if (!(x.verifications ?? []).some((v: Obj) => v.partyUserId === me(c) && v.checkType === checkType)) (x.verifications ||= []).push({ partyUserId: me(c), checkType, status: 'PASSED', detail, checkedAt: now });
      };
      add('IDENTITY', { failures: [] });
      add('PROPERTY', { failures: [], propertyId: prop });
      if (action === 'safety-ack' || b.acknowledged) add('SAFETY_ACK', { acknowledgedAt: now, demo: true });
      const done = (uid: string) => (x.verifications ?? []).some((v: Obj) => v.partyUserId === uid && v.checkType === 'SAFETY_ACK');
      if (done(x.requesterId) && done(x.responderId)) {
        x.status = 'AGREEMENT_PENDING';
        x.agreement = makeAgreement(x);
        notify(x.requesterId, 'exchange.agreement.ready', '맞교환 계약서가 준비되었습니다', '계약서를 확인하고 서명해 주세요', { exchangeId: id });
        notify(x.responderId, 'exchange.agreement.ready', '맞교환 계약서가 준비되었습니다', '계약서를 확인하고 서명해 주세요', { exchangeId: id });
      }
      break;
    }
    case 'confirm':
      if (x.status === 'CONFIRMED') break;
      if (x.status !== 'AGREEMENT_PENDING' || !x.agreement?.signatures?.requester || !x.agreement?.signatures?.responder) return problem(409, 'AGREEMENT_NOT_SIGNED', 'Both parties must sign first');
      x.status = 'CONFIRMED';
      x.confirmedAt = now;
      break;
    case 'cancel':
      if (!['CONFIRMED', 'AGREEMENT_PENDING', 'VERIFICATION_PENDING'].includes(x.status)) return bad('CONFIRMED');
      x.status = 'CANCELLED';
      x.cancelledAt = now;
      notify(counterpart(c, x), 'exchange.cancelled', '맞교환이 취소되었습니다', b.reason ?? '', { exchangeId: id });
      break;
    case 'complete':
      if (!['CONFIRMED', 'IN_PROGRESS'].includes(x.status)) return bad('IN_PROGRESS');
      x.status = 'COMPLETED';
      x.completedAt = now;
      break;
    case 'dispute':
      x.status = 'DISPUTED';
      break;
  }
  saveExchange(x);
  return action === 'dispute' ? created({ item: { id: uuid(), status: 'OPEN', exchangeId: id } }) : ok({ item: exView(c, x) });
});
function hex64(s: string): string {
  let h1 = 0x811c9dc5;
  let out = '';
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h1 = Math.imul(h1 ^ r, 16777619) >>> 0;
    out += h1.toString(16).padStart(8, '0');
  }
  return out;
}
function makeAgreement(x: Obj): Obj {
  const tpl = clone(itemOf(anyBody(`/v1/exchanges/${F.ids.exchangeIds?.find((id) => anyBody(`/v1/exchanges/${id}/agreement`))}/agreement`)) ?? {});
  const offer = x.currentOffer ?? {};
  const snap = {
    ...(tpl.termsSnapshot ?? {}),
    exchangeId: x.id,
    offerVersion: x.currentOfferVersion,
    offer: { terms: offer.terms ?? {}, datesA: offer.datesA, datesB: offer.datesB, guestsA: offer.guestsA, guestsB: offer.guestsB, createdBy: offer.createdBy },
    parties: { requester: { userId: x.requesterId, propertyId: x.propertyA?.id }, responder: { userId: x.responderId, propertyId: x.propertyB?.id } },
    homes: {
      A: { ...(tpl.termsSnapshot?.homes?.A ?? {}), title: x.propertyA?.title, propertyId: x.propertyA?.id },
      B: { ...(tpl.termsSnapshot?.homes?.B ?? {}), title: x.propertyB?.title, propertyId: x.propertyB?.id },
    },
  };
  return { ...tpl, id: uuid(), status: 'PENDING', termsVersion: tpl.termsVersion ?? '2026-10-draft', termsHash: hex64(JSON.stringify(snap)), offerVersion: x.currentOfferVersion, termsSnapshot: snap, signatures: { requester: null, responder: null }, createdAt: nowIso() };
}
on('GET', /^\/v1\/exchanges\/([^/]+)\/agreement$/, (c, id) => {
  if (!c.p) return unauth();
  const local = entity('exchange', id);
  if (!local) return null;
  if (!local.agreement) return notFound('Agreement');
  return ok({ item: local.agreement });
});
on('POST', /^\/v1\/exchanges\/([^/]+)\/agreement\/sign$/, (c, id) => {
  if (!c.p) return unauth();
  const x0 = getExchange(c, id);
  if (!x0) return notFound('Exchange');
  const x = clone(x0);
  if (x.status !== 'AGREEMENT_PENDING') return problem(409, 'AGREEMENT_NOT_SIGNABLE', `Exchange is ${x.status}`);
  x.agreement ||= makeAgreement(x);
  if (c.body?.termsHash && c.body.termsHash !== x.agreement.termsHash) return problem(409, 'AGREEMENT_STALE', 'The agreement changed — reload and sign again');
  const side = x.requesterId === me(c) ? 'requester' : 'responder';
  x.agreement.signatures = { ...(x.agreement.signatures ?? {}), [side]: { userId: me(c), signedAt: nowIso(), termsHash: x.agreement.termsHash, demo: true } };
  if (x.agreement.signatures.requester && x.agreement.signatures.responder) {
    x.agreement.status = 'SIGNED';
    x.status = 'CONFIRMED';
    x.confirmedAt = nowIso();
    for (const u of [x.requesterId, x.responderId]) notify(u, 'exchange.confirmed', '맞교환이 확정되었습니다 🎉', `${x.propertyA?.title} ⇄ ${x.propertyB?.title}`, { exchangeId: id });
  } else notify(counterpart(c, x), 'exchange.signed', '상대방이 계약서에 서명했습니다', '서명하면 맞교환이 확정됩니다', { exchangeId: id });
  saveExchange(x);
  return ok({ item: exView(c, x) });
});

// ============================================================================================ guides
function getGuideRequest(c: Ctx, id: string): Obj | undefined {
  const local = entity('guideRequest', id);
  if (local) return local;
  for (const k of [c.key, 'guest', 'guide', 'proGuide', 'exchange', ...Object.keys(F.personas)]) {
    const h = lookupFor(k, `/v1/guide-requests/${id}`, new URLSearchParams());
    if (h && h.status < 300) return itemOf(h.body);
  }
  return undefined;
}
function getGuideBooking(c: Ctx, id: string): Obj | undefined {
  const local = entity('guideBooking', id);
  if (local) return local;
  for (const k of [c.key, 'guest', 'guide', 'proGuide', ...Object.keys(F.personas)]) {
    const h = lookupFor(k, `/v1/guide-bookings/${id}`, new URLSearchParams());
    if (h && h.status < 300) return itemOf(h.body);
  }
  return undefined;
}
const grSees = (c: Ctx, r: Obj) => r.traveler_id === me(c) || r.guide_id === me(c) || (!r.guide_id && (c.p?.roles ?? []).includes('GUIDE')) || c.key === 'admin';
on('GET', /^\/v1\/guide-requests$/, (c) => {
  if (!c.p) return unauth();
  const role = c.query.get('role');
  const mine = (r: Obj) => (role === 'guide' ? r.guide_id === me(c) : role === 'open' ? !r.guide_id || (r.guide_id === me(c) && r.status === 'REQUESTED') : role === 'traveler' ? r.traveler_id === me(c) : r.traveler_id === me(c) || r.guide_id === me(c));
  const local = entities('guideRequest').filter(mine);
  const rows = mergeById(local, recordedItems(c, '/v1/guide-requests', c.query), 'guideRequest').map((r) => entity('guideRequest', r.id) ?? r);
  return ok({ items: rows.filter(mine), nextCursor: null });
});
on('GET', /^\/v1\/guide-requests\/([^/]+)$/, (c, id) => {
  if (!c.p) return unauth();
  const r = getGuideRequest(c, id);
  if (!r || !grSees(c, r)) return notFound('Guide request');
  return ok({ item: r });
});
on('POST', /^\/v1\/guide-requests$/, (c) => {
  if (!c.p) return unauth();
  const b = c.body ?? {};
  if (b.guideId === me(c)) return problem(422, 'SELF_REQUEST', 'You cannot request yourself');
  const now = nowIso();
  const r = {
    id: poolId('guideRequest'),
    traveler_id: me(c),
    guide_id: b.guideId ?? null,
    start_at: b.startAt,
    end_at: b.endAt,
    party_size: b.partySize ?? 1,
    city: b.city ?? null,
    languages: b.languages ?? [],
    interests: b.interests ?? [],
    scope: b.scope ?? {},
    message: b.message ?? null,
    status: 'REQUESTED',
    current_offer_version: 0,
    created_at: now,
    offers: [],
    booking: null,
    guideName: b.guideId ? personaName(b.guideId) : undefined,
    demo: true,
  };
  putEntity('guideRequest', r);
  if (b.guideId) notify(b.guideId, 'guide.request.received', '새 가이드 요청이 도착했습니다', `${c.p.displayName} · ${r.city ?? ''}`, { requestId: r.id });
  const { offers, booking, ...item } = r;
  return created({ item });
});
on('POST', /^\/v1\/guide-requests\/([^/]+)\/(offers|counter|accept|decline|cancel)$/, (c, id, action) => {
  if (!c.p) return unauth();
  const r0 = getGuideRequest(c, id);
  if (!r0 || !grSees(c, r0)) return notFound('Guide request');
  const r = clone(r0);
  r.offers ||= [];
  const now = nowIso();
  const b = c.body ?? {};
  const last = r.offers[r.offers.length - 1];
  if (action === 'offers' || action === 'counter') {
    if (!['REQUESTED', 'OFFERED', 'COUNTERED'].includes(r.status)) return problem(409, 'INVALID_STATE_TRANSITION', `Request is ${r.status}`);
    const v = Number(r.current_offer_version ?? 0) + 1;
    for (const o of r.offers) if (o.status === 'OPEN') o.status = 'SUPERSEDED';
    const offer = { id: uuid(), request_id: id, version: v, created_by: me(c), start_at: b.startAt ?? last?.start_at ?? r.start_at, end_at: b.endAt ?? last?.end_at ?? r.end_at, paid: b.paid ?? (Number(b.priceMinor ?? last?.price_minor ?? 0) > 0), price_minor: Number(b.priceMinor ?? last?.price_minor ?? 0), currency: 'KRW', itinerary: b.itinerary ?? last?.itinerary ?? null, status: 'OPEN', created_at: now };
    r.offers.push(offer);
    Object.assign(r, { status: action === 'offers' ? 'OFFERED' : 'COUNTERED', current_offer_version: v });
    if (!r.guide_id && action === 'offers') r.guide_id = me(c);
    putEntity('guideRequest', r);
    notify(me(c) === r.traveler_id ? r.guide_id : r.traveler_id, 'guide.offer.received', action === 'offers' ? '가이드 제안이 도착했습니다' : '조건 변경 제안이 도착했습니다', personaName(me(c)), { requestId: id });
    const { offers, booking, ...item } = r;
    return created({ item, offer });
  }
  if (action === 'accept') {
    const v = Number(b.offerVersion ?? r.current_offer_version);
    const offer = r.offers.find((o: Obj) => Number(o.version) === v);
    if (!offer) return problem(409, 'STALE_OFFER', 'Offer version not found');
    if (r.booking?.id) return ok({ item: r, offer, booking: r.booking });
    offer.status = 'ACCEPTED';
    r.status = 'ACCEPTED';
    const paid = !!offer.paid && Number(offer.price_minor) > 0;
    const bkId = poolId('guideBooking');
    const conv = ensureConversation('GUIDE_BOOKING', bkId, [
      { userId: r.traveler_id, role: 'TRAVELER' },
      { userId: r.guide_id, role: 'GUIDE' },
    ]);
    const tpl = itemOf(anyBody(`/v1/guide-bookings/${F.ids.guideBookingIds?.[0]}`)) ?? {};
    const booking = {
      ...clone(tpl),
      id: bkId,
      request_id: id,
      offer_id: offer.id,
      guide_id: r.guide_id,
      traveler_id: r.traveler_id,
      guide_type: paid ? 'PROFESSIONAL' : 'FRIEND',
      start_at: offer.start_at,
      end_at: offer.end_at,
      status: paid ? 'PAYMENT_PENDING' : 'CONFIRMED',
      paid,
      price_minor: paid ? Number(offer.price_minor) : 0,
      refunded_minor: 0,
      currency: 'KRW',
      conversation_id: conv.id,
      version: paid ? 1 : 2,
      created_at: now,
      updated_at: now,
      guideName: personaName(r.guide_id),
      history: [{ from_state: null, to_state: 'ACCEPTED', actor_type: 'USER', reason: 'offer accepted', created_at: now }, ...(paid ? [] : [{ from_state: 'ACCEPTED', to_state: 'CONFIRMED', actor_type: 'USER', reason: 'free booking confirmed on acceptance', created_at: now }])],
      demo: true,
    };
    putEntity('guideBooking', booking);
    r.booking = { id: bkId, status: booking.status };
    putEntity('guideRequest', r);
    notify(r.guide_id, 'guide.offer.accepted', '가이드 제안이 수락되었습니다', personaName(r.traveler_id), { bookingId: bkId });
    const { offers, ...item } = r;
    return ok({ item, offer, booking });
  }
  r.status = action === 'decline' ? 'DECLINED' : 'CANCELLED';
  putEntity('guideRequest', r);
  return ok({ item: r });
});
on('GET', /^\/v1\/guide-bookings$/, (c) => {
  if (!c.p) return unauth();
  const role = c.query.get('role');
  const mine = (b: Obj) => (role === 'guide' ? b.guide_id === me(c) : role === 'traveler' ? b.traveler_id === me(c) : b.traveler_id === me(c) || b.guide_id === me(c));
  const rows = mergeById(entities('guideBooking').filter(mine), recordedItems(c, '/v1/guide-bookings', c.query), 'guideBooking').map((b) => entity('guideBooking', b.id) ?? b);
  return ok({ items: rows.filter(mine), nextCursor: null });
});
on('GET', /^\/v1\/guide-bookings\/([^/]+)$/, (c, id) => {
  if (!c.p) return unauth();
  const b = getGuideBooking(c, id);
  if (!b || (b.traveler_id !== me(c) && b.guide_id !== me(c) && c.key !== 'admin')) return notFound('Guide booking');
  return ok({ item: b });
});
on('POST', /^\/v1\/guide-bookings\/([^/]+)\/(cancel|start|complete|dispute)$/, (c, id, action) => {
  if (!c.p) return unauth();
  const b0 = getGuideBooking(c, id);
  if (!b0) return notFound('Guide booking');
  const b = clone(b0);
  const to = { cancel: 'CANCELLED', start: 'IN_PROGRESS', complete: 'COMPLETED', dispute: 'DISPUTED' }[action as 'cancel'];
  b.history = [...(b.history ?? []), { from_state: b.status, to_state: to, actor_type: 'USER', reason: c.body?.reason ?? `${action} (demo)`, created_at: nowIso() }];
  b.status = to;
  b.updated_at = nowIso();
  putEntity('guideBooking', b);
  return ok({ item: b });
});

// ============================================================================================ orders
function getOrder(c: Ctx, id: string): Obj | undefined {
  return entity('order', id) ?? recordedDetail(c, `/v1/orders/${id}`, (o) => o.buyerId === me(c) || c.key === 'admin');
}
function findDeparture(depId: string): { dep: Obj; product: Obj } | null {
  for (const pid of F.ids.travelProductIds ?? []) {
    const deps = itemsOf(anyBody(`/v1/travel-products/${pid}/departures`));
    const dep = deps.find((d) => d.id === depId);
    if (dep) return { dep, product: itemOf(anyBody(`/v1/travel-products/${pid}`)) ?? {} };
  }
  return null;
}
on('POST', /^\/v1\/orders$/, (c) => {
  if (!c.p) return unauth();
  const lines = Array.isArray(c.body?.items) ? c.body.items : [];
  if (!lines.length) return problem(400, 'VALIDATION_FAILED', 'items required');
  const tpl = itemOf(F.templates?.order) ?? {};
  const now = nowIso();
  const items: Obj[] = [];
  for (const l of lines) {
    const f = findDeparture(String(l.departureId));
    if (!f) return notFound('Departure');
    const qty = Number(l.qty || 1);
    if (Number(f.dep.remaining ?? 99) < qty) return problem(409, 'SOLD_OUT', '남은 자리가 부족합니다');
    const unit = Number(f.dep.priceMinor ?? f.product.basePriceMinor ?? 0);
    items.push({ id: uuid(), sellableType: 'TRAVEL_DEPARTURE', sellableId: f.dep.id, supplierId: f.product.supplierId, title: f.product.title, qty, unitPriceMinor: unit, amountMinor: unit * qty, status: 'ACTIVE', vouchers: [], startsAt: f.dep.startsAt, productId: f.product.id });
  }
  const subtotal = items.reduce((s, x) => s + x.amountMinor, 0);
  const tp = tpl.pricing ?? {};
  const pRate = tp.subtotalMinor ? Number(tp.platformFeeMinor) / Number(tp.subtotalMinor) : 0.05;
  const tRate = tp.platformFeeMinor ? Number(tp.taxMinor) / Number(tp.platformFeeMinor) : 0.1;
  const platformFeeMinor = Math.round(subtotal * pRate);
  const taxMinor = Math.round(platformFeeMinor * tRate);
  const o = {
    ...clone(tpl),
    id: poolId('order'),
    code: code(10),
    buyerId: me(c),
    status: 'PENDING',
    currency: 'KRW',
    subtotalMinor: subtotal,
    feeMinor: platformFeeMinor + taxMinor,
    totalMinor: subtotal + platformFeeMinor + taxMinor,
    refundedMinor: 0,
    pricing: { ...(tp ?? {}), subtotalMinor: subtotal, platformFeeMinor, taxMinor, totalMinor: subtotal + platformFeeMinor + taxMinor, quotedAt: now },
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    fulfilledAt: null,
    cancelledAt: null,
    createdAt: now,
    items,
    title: items[0]?.title,
    demo: true,
  };
  putEntity('order', o);
  return created({ item: o });
});
on('GET', /^\/v1\/orders$/, (c) => {
  if (!c.p) return unauth();
  const rows = mergeById(entities('order').filter((o) => o.buyerId === me(c)), recordedItems(c, '/v1/orders'), 'order').map((o) => entity('order', o.id) ?? o);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return ok({ items: rows, nextCursor: null });
});
on('GET', /^\/v1\/orders\/([^/]+)$/, (c, id) => {
  if (!c.p) return unauth();
  const o = getOrder(c, id);
  return o ? ok({ item: o }) : notFound('Order');
});
on('POST', /^\/v1\/orders\/([^/]+)\/cancel$/, (c, id) => {
  if (!c.p) return unauth();
  const o0 = getOrder(c, id);
  if (!o0) return notFound('Order');
  const o: Obj = { ...clone(o0), status: 'CANCELLED', cancelledAt: nowIso(), refundedMinor: o0.status === 'PAID' ? o0.totalMinor : 0 };
  o.items = (o.items ?? []).map((it: Obj) => ({ ...it, status: 'CANCELLED', vouchers: (it.vouchers ?? []).map((v: Obj) => ({ ...v, status: 'VOID' })) }));
  putEntity('order', o);
  return ok({ item: o });
});

// ============================================================================================ reviews
on('POST', /^\/v1\/reviews$/, (c) => {
  if (!c.p) return unauth();
  const b = c.body ?? {};
  if (!b.rating) return problem(400, 'VALIDATION_FAILED', 'rating is required');
  const r = { id: uuid(), authorId: me(c), authorName: c.p.displayName, transactionType: b.transactionType, transactionId: b.transactionId, targetType: b.targetType, targetId: b.targetId, rating: Number(b.rating), subRatings: b.subRatings ?? {}, body: b.body ?? '', status: 'PUBLISHED', response: null, createdAt: nowIso(), demo: true };
  putEntity('review', r);
  return created({ item: r });
});
on('GET', /^\/v1\/reviews$/, (c) => {
  const tid = c.query.get('targetId');
  const local = entities('review').filter((r) => !tid || r.targetId === tid);
  const h = recorded(c);
  const rows = h && h.status < 300 ? itemsOf(h.body) : [];
  if (!local.length) return h ? null : ok({ items: [], nextCursor: null });
  return ok({ ...(h?.body ?? {}), items: [...local, ...rows], nextCursor: null });
});
on('GET', /^\/v1\/me\/reviews$/, (c) => {
  if (!c.p) return unauth();
  const local = entities('review').filter((r) => r.authorId === me(c));
  const h = recorded(c);
  const body = h && h.status < 300 && !c.p.custom ? h.body : { items: [] };
  if (Array.isArray(body.items)) body.items = [...local, ...body.items];
  else if (body.written) body.written = [...local, ...(Array.isArray(body.written) ? body.written : body.written.items ?? [])];
  return ok(body);
});

// ============================================================================================ assistant
on('POST', /^\/v1\/ai\/travel-assistant$/, (c) => {
  const msg = String(c.body?.message ?? '');
  const res = searchProperties(new URLSearchParams({ q: msg.match(/서울|제주|부산|강릉|경주|속초|seoul|jeju|busan|gangneung|gyeongju|sokcho/i)?.[0] ?? '', limit: '3' }));
  const stays = (res.items as Obj[]).slice(0, 3);
  const guides = allGuides().slice(0, 1);
  return ok({
    item: {
      sessionId: c.body?.sessionId ?? uuid(),
      reply: stays.length
        ? `정적 데모의 AI 도우미입니다. "${msg.slice(0, 40)}"에 어울리는 숙소 ${stays.length}곳을 골라 봤어요. 날짜를 정하면 숙소 페이지에서 바로 요금을 확인할 수 있어요.`
        : '정적 데모의 AI 도우미입니다. 도시 이름(예: 제주, 부산, 강릉)을 넣어 다시 물어봐 주세요.',
      suggestions: [
        ...stays.map((p) => ({ type: 'PROPERTY', id: p.slug, title: p.title, city: p.city, price: { amountMinor: p.priceMinor, currency: p.currency }, action: { href: `/stay/${p.slug}` } })),
        ...guides.map((g) => ({ type: 'GUIDE', id: g.guideId, title: g.displayName, city: g.city, action: { href: `/guides/${g.guideId}` } })),
      ],
      disclaimer: '데모 응답입니다 — 실제 AI 모델을 호출하지 않습니다. / Demo response, no AI model is called.',
    },
  });
});
function allGuides(): Obj[] {
  const h = lookupFor('anon', '/v1/search/guides', new URLSearchParams());
  return itemsOf(h?.body).map((x) => x.guide ?? x);
}

// ============================================================================================ CMS entries
/**
 * Enough of OPS-03 for the admin's main-page editor (`/admin/home`) to be real in the static demo: entries the
 * editor creates or edits live in localStorage, are merged into the admin list, and — once PUBLISHED — into the
 * public `/v1/content/<type>` list the home page reads. Recorded CMS entries stay read-only.
 */
const CMS_EDITOR_ROLES = ['ADMIN', 'EDITOR'];
const cmsEditor = (c: Ctx) => !!c.p && c.p.roles.some((r) => CMS_EDITOR_ROLES.includes(r));
const cmsEntryDto = (e: Obj) => ({ ...e, demo: true });
/** `type` / `locale` / `status` filtering, as the API's querystring does it. */
function cmsFilter(rows: Obj[], q: URLSearchParams): Obj[] {
  let out = rows;
  for (const k of ['type', 'locale', 'status'] as const) {
    const v = q.get(k);
    if (v) out = out.filter((r) => String(r[k] ?? '').toUpperCase() === v.toUpperCase());
  }
  return out;
}

on('GET', /^\/v1\/admin\/cms\/entries$/, (c) => {
  if (!cmsEditor(c)) return null; // fall through to the recorded 401/403 for everyone else
  const rows = mergeById(entities('cmsEntry'), recordedItems(c, '/v1/admin/cms/entries', c.query), 'cmsEntry');
  return ok({ items: cmsFilter(rows, c.query), nextCursor: null });
});

on('POST', /^\/v1\/admin\/cms\/entries$/, (c) => {
  if (!cmsEditor(c)) return unauth();
  const b = c.body ?? {};
  const slug = String(b.slug ?? '');
  const locale = String(b.locale ?? 'ko-KR');
  if (!slug) return problem(400, 'VALIDATION_FAILED', 'slug is required');
  const existing = entities('cmsEntry').find((e) => e.slug === slug && e.locale === locale);
  if (existing) return problem(409, 'CONFLICT', '같은 slug/언어의 콘텐츠가 이미 있습니다 / An entry with this slug and locale already exists');
  const now = nowIso();
  const e = putEntity('cmsEntry', { id: uuid(), type: b.type ?? 'PAGE', slug, locale, title: b.title ?? slug, summary: b.summary ?? null, bodyMd: b.bodyMd ?? null, seo: b.seo ?? {}, data: b.data ?? {}, status: 'DRAFT', publishedAt: null, updatedAt: now, createdAt: now });
  return created({ item: cmsEntryDto(e) });
});

on('PATCH', /^\/v1\/admin\/cms\/entries\/([^/]+)$/, (c, id) => {
  if (!cmsEditor(c)) return unauth();
  const e = entity('cmsEntry', id);
  if (!e) return notFound('Content');
  const b = c.body ?? {};
  for (const k of ['title', 'summary', 'bodyMd', 'seo', 'data', 'locale', 'slug']) if (b[k] !== undefined) e[k] = b[k];
  e.updatedAt = nowIso();
  putEntity('cmsEntry', e);
  return ok({ item: cmsEntryDto(e) });
});

on('POST', /^\/v1\/admin\/cms\/entries\/([^/]+)\/(publish|unpublish|archive|restore)$/, (c, id, action) => {
  if (!cmsEditor(c)) return unauth();
  const e = entity('cmsEntry', id);
  if (!e) return notFound('Content');
  const status = action === 'publish' ? 'PUBLISHED' : action === 'archive' ? 'ARCHIVED' : 'DRAFT';
  e.status = status;
  e.publishedAt = status === 'PUBLISHED' ? nowIso() : null;
  e.updatedAt = nowIso();
  putEntity('cmsEntry', e);
  return ok({ item: cmsEntryDto(e) });
});

on('GET', /^\/v1\/content\/([a-z-]+)$/, (c, type) => {
  const local = entities('cmsEntry').filter((e) => e.status === 'PUBLISHED' && String(e.type).toUpperCase() === type.toUpperCase());
  if (!local.length) return null; // nothing authored in this browser → recorded content as before
  const h = recorded(c);
  const rows = h && h.status < 300 ? narrow(h.body, c.query).items ?? [] : [];
  const locale = c.query.get('locale');
  // The API prefers the requested locale per slug and falls back to ko-KR; mirror that for local entries only.
  const slugs = new Set(local.map((e) => e.slug));
  const preferred = locale ? local.filter((e) => e.locale === locale) : local;
  const chosen = [...preferred, ...local.filter((e) => e.locale === 'ko-KR' && !preferred.some((p) => p.slug === e.slug))];
  return ok({ items: [...chosen.map(cmsEntryDto), ...rows.filter((r: Obj) => !slugs.has(r.slug))], nextCursor: null });
});

// ============================================================================================ misc
on('POST', /^\/v1\/analytics\/events$/, () => json(202, { accepted: true }));
on('GET', /^\/v1\/seo\/redirects$/, () => problem(404, 'NOT_FOUND', 'No redirect'));
on('POST', /^\/v1\/charter\/requests$/, (c) => created({ item: { id: uuid(), status: 'RECEIVED', ...(c.body ?? {}), createdAt: nowIso(), demo: true } }));
on('POST', /^\/v1\/support\/cases$/, (c) => {
  if (!c.p) return unauth();
  return created({ item: { id: uuid(), number: 'CS-' + code(6), status: 'OPEN', ...(c.body ?? {}), createdAt: nowIso(), demo: true } });
});
