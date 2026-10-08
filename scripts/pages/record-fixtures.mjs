#!/usr/bin/env node
/**
 * Records the API responses the static GitHub Pages demo replays (packages/demo/fixtures/api.json).
 *
 *   node scripts/pages/record-fixtures.mjs [--api http://localhost:4000] [--scenario] [--out path]
 *
 * - Logs in as every demo persona (admin is stepped up to AAL2 via TOTP enrollment), plus anonymous.
 * - Discovers the GET endpoints the web calls by scanning apps/web/{app,components,lib} for '/v1/' string
 *   literals and matching them against packages/contracts/openapi.json; ids for detail endpoints are
 *   harvested from list responses.
 * - --scenario first creates realistic demo activity through the REAL API (bookings paid with the MOCK
 *   provider, an inquiry thread, favorites, home exchanges, guide requests/offers, a tour order). Only use
 *   it against an isolated recording database — scripts/pages/record.sh sets that up.
 * - Tokens/secrets are scrubbed. Identical bodies are stored once in a body table.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const API = (opt('api', process.env.API_URL || 'http://localhost:4000')).replace(/\/$/, '');
const OUT = path.resolve(opt('out', path.join(ROOT, 'packages/demo/fixtures/api.json')));
const SCENARIO = flag('scenario');
const PASSWORD = process.env.DEMO_PASSWORD || 'Jetpool!2026dev';
const CONCURRENCY = Number(opt('concurrency', '6'));

const PERSONAS = {
  guest: 'guest@jetpool.dev',
  host: 'host.seoul@jetpool.dev',
  hostJeju: 'host.jeju@jetpool.dev',
  exchange: 'exchange.busan@jetpool.dev',
  guide: 'friend.guide@jetpool.dev',
  proGuide: 'pro.guide@jetpool.dev',
  supplier: 'supplier@jetpool.dev',
  admin: 'admin@jetpool.dev',
};

const log = (...a) => console.log('[record]', ...a);
const warn = (...a) => console.warn('[record] WARN', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};
const TODAY = isoDate(new Date());
const poolUuid = (kind, i) => {
  const h = createHash('sha256').update(`jetpool-demo-pool:${kind}:${i}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// ------------------------------------------------------------------------------------------ HTTP / sessions
const sessions = {}; // key -> { email, accessToken, refreshToken, user, aal, login }

async function raw(method, p, { body, token, headers = {} } = {}) {
  // Several money/inventory mutations require an Idempotency-Key; sending one everywhere is harmless.
  if (method !== 'GET' && !headers['idempotency-key']) headers = { ...headers, 'idempotency-key': `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API + p, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    } catch (e) {
      // The API may be restarting (other work hot-reloads apps/api); retry a few times.
      if (attempt >= 5) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function refresh(key) {
  const s = sessions[key];
  if (!s?.refreshToken) return false;
  const r = await raw('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } });
  if (r.status !== 200 || !r.body?.accessToken) return false;
  s.accessToken = r.body.accessToken;
  if (r.body.refreshToken) s.refreshToken = r.body.refreshToken;
  return true;
}

/** Request as a persona ('anon' = no token); transparently refreshes an expired access token once. */
async function call(key, method, p, opts = {}) {
  const s = key === 'anon' ? null : sessions[key];
  let r = await raw(method, p, { ...opts, token: s?.accessToken });
  if (r.status === 401 && s && (await refresh(key))) r = await raw(method, p, { ...opts, token: s.accessToken });
  return r;
}
const must = async (key, method, p, body, headers) => {
  const r = await call(key, method, p, { body, headers });
  if (r.status >= 400) throw new Error(`${key} ${method} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const idem = (k) => ({ 'idempotency-key': k });

async function loginAll() {
  for (const [key, email] of Object.entries(PERSONAS)) {
    const r = await raw('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    if (r.status !== 200) {
      warn(`login failed for ${email}: ${r.status}`);
      continue;
    }
    sessions[key] = { email, accessToken: r.body.accessToken, refreshToken: r.body.refreshToken, user: r.body.user, aal: r.body.aal, login: r.body };
  }
  if (sessions.admin) await stepUpAdmin();
}

async function totpCode(secret) {
  const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
  const OTPAuth = require('otpauth');
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
}

async function stepUpAdmin() {
  const s = sessions.admin;
  const enroll = await call('admin', 'POST', '/v1/auth/mfa/totp/enroll', { body: {} });
  if (enroll.status === 201 && enroll.body?.secret) {
    const v = await call('admin', 'POST', '/v1/auth/mfa/totp/verify', { body: { factorId: enroll.body.factorId, code: await totpCode(enroll.body.secret) } });
    if (v.status === 200 && v.body?.accessToken) {
      s.accessToken = v.body.accessToken;
      s.aal = 'aal2';
      log('admin: TOTP enrolled, session upgraded to AAL2');
      return;
    }
    warn('admin TOTP verify failed', v.status, JSON.stringify(v.body).slice(0, 200));
  }
  const secret = process.env.ADMIN_TOTP_SECRET;
  const recovery = process.env.ADMIN_RECOVERY_CODE;
  if (secret || recovery) {
    const c = await call('admin', 'POST', '/v1/auth/mfa/challenge', { body: secret ? { code: await totpCode(secret) } : { recoveryCode: recovery } });
    if (c.status === 200 && c.body?.accessToken) {
      s.accessToken = c.body.accessToken;
      s.aal = 'aal2';
      log('admin: MFA challenge passed (AAL2)');
      return;
    }
  }
  warn('admin stays at AAL1 (MFA already enrolled? set ADMIN_TOTP_SECRET or ADMIN_RECOVERY_CODE) — admin screens will show AAL2-required errors');
}

// ------------------------------------------------------------------------------------------ demo scenario
const templates = {};
async function step(name, fn) {
  try {
    const out = await fn();
    log(`scenario: ${name} ✓`);
    return out;
  } catch (e) {
    warn(`scenario: ${name} failed: ${e.message}`);
    return null;
  }
}

async function bookStay(key, propertyId, checkIn, nights, guests, tag) {
  const quote = await must(key, 'POST', '/v1/booking/quotes', { propertyId, checkIn, checkOut: addDays(checkIn, nights), guests });
  const q = quote.item;
  const hold = await must(key, 'POST', '/v1/booking/holds', { quoteId: q.id }, idem(`demo-hold-${q.id}`));
  const rid = hold.item.reservation.id;
  const prep = await must(key, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: rid }, idem(`demo-prep-${rid}`));
  const confirm = await must(key, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${prep.orderId}`, orderId: prep.orderId, amount: prep.amount }, idem(`confirm-${prep.orderId}`));
  if (tag) Object.assign(templates, { quote, hold, prepare: prep, confirm });
  return { quote: q, reservationId: rid, prepare: prep, confirm };
}

/** Try a few listings/dates until a stay can be booked (the seed already holds many reservations). */
async function bookSomewhere(key, candidates, offsets, nights, guests, tag) {
  for (const p of candidates) {
    for (const off of offsets) {
      try {
        const r = await bookStay(key, p.id, addDays(TODAY, off), nights, guests, tag);
        return { ...r, property: p };
      } catch (e) {
        if (!/DATES_UNAVAILABLE|INVENTORY_UNAVAILABLE|MIN_NIGHTS|MAX_GUESTS|SELF_BOOKING|NOT_BOOKABLE|HOLD_EXISTS/.test(e.message)) throw e;
      }
    }
  }
  throw new Error('no bookable listing/date found');
}

async function runScenario() {
  log('scenario: creating demo activity through the real API');
  // Seeded listings are inserted with SQL; make sure the search projection is complete.
  if (sessions.admin?.aal === 'aal2') {
    const before = (await must('anon', 'GET', '/v1/search/properties?limit=50')).total ?? 0;
    await step('admin search reindex', () => must('admin', 'POST', '/v1/admin/search/reindex', { reset: true }));
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const t = (await must('anon', 'GET', '/v1/search/properties?limit=50')).total ?? 0;
      if (t >= before && t > 0 && i >= 2) {
        log(`scenario: search index has ${t} listings`);
        break;
      }
    }
  }
  const all = [...((await must('anon', 'GET', '/v1/search/properties?limit=50')).items ?? []), ...((await must('anon', 'GET', '/v1/search/properties?limit=50&page=2')).items ?? [])];
  if (!all.length) throw new Error('search returned no listings — is the worker indexing?');
  const hostOf = async (p) => {
    const d = await must('anon', 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`);
    return d.item?.host?.id ?? d.item?.hostId;
  };
  const me = (k) => sessions[k]?.user?.id;
  const bookable = all.filter((p) => p.rentalEnabled && p.paidBookingEnabled && (p.maxGuests ?? 2) >= 2);
  // Prefer listings of the recorded host personas so their dashboards show the new bookings too.
  const byHost = [];
  for (const p of bookable) byHost.push({ ...p, hostId: await hostOf(p) });
  const forGuest = [...byHost.filter((p) => p.hostId === me('host')), ...byHost.filter((p) => p.hostId === me('hostJeju')), ...byHost.filter((p) => ![me('host'), me('hostJeju')].includes(p.hostId))];

  // Guest stays (MOCK payments) far enough ahead not to collide with seeded reservations.
  await step('guest books a Seoul stay (template)', () => bookSomewhere('guest', forGuest, [150, 165, 180, 195], 3, 2, true));
  await step('guest books a Jeju stay', () => bookSomewhere('guest', forGuest.filter((p) => p.hostId === me('hostJeju')).concat(forGuest), [205, 220, 235], 4, 2));

  // Inquiry thread with the Seoul host.
  const inquiryTarget = byHost.find((p) => p.hostId === me('host')) ?? byHost[0];
  await step('guest inquiry + host reply', async () => {
    const conv = await must('guest', 'POST', '/v1/conversations', {
      contextType: 'INQUIRY', targetType: 'PROPERTY', targetId: inquiryTarget.id,
      message: '안녕하세요! 다음 달 말부터 2주 정도 머물 수 있을까요? 재택근무용 책상이 있는지도 궁금해요.', clientMessageId: 'demo-inq-1',
    });
    templates.conversation = conv;
    const cid = conv.item?.id ?? conv.id;
    templates.message = await must('host', 'POST', `/v1/conversations/${cid}/messages`, { body: '안녕하세요! 네, 창가에 넓은 책상과 모니터가 있어요. 2주 이상 머무시면 장기 숙박 할인도 적용됩니다 :)', clientMessageId: 'demo-reply-1' });
    await must('guest', 'POST', `/v1/conversations/${cid}/messages`, { body: '좋아요! 날짜 확정되면 바로 예약할게요. 감사합니다 🙏', clientMessageId: 'demo-inq-2' });
  });

  // Favorites (a few cities).
  await step('guest favorites', async () => {
    const seen = new Set();
    for (const p of all) {
      if (seen.has(p.city) || seen.size >= 3) continue;
      seen.add(p.city);
      const r = await call('guest', 'POST', '/v1/favorites', { body: { targetType: 'PROPERTY', targetId: p.id } });
      if (r.status < 300) templates.favorite = r.body;
    }
  });

  // A fresh home-exchange request for the Seoul host to answer in the demo.
  await step('exchange request (REQUESTED)', async () => {
    const homes = (await must('exchange', 'GET', '/v1/exchange/homes?limit=50')).items ?? [];
    const mine = (await must('exchange', 'GET', '/v1/host/properties')).items?.find((p) => p.exchangeEnabled);
    const theirs = homes.find((h) => (h.host?.id ?? h.hostId) === me('host')) ?? homes[0];
    if (!mine || !theirs) throw new Error('no exchange homes');
    for (const off of [240, 270, 300]) {
      const start = addDays(TODAY, off);
      const r = await call('exchange', 'POST', '/v1/exchanges', {
        body: { myPropertyId: mine.id, theirPropertyId: theirs.id, datesA: { start, end: addDays(start, 21) }, datesB: { start, end: addDays(start, 21) }, guestsA: 2, guestsB: 2, message: '안녕하세요! 저희 부산 집과 3주 맞교환 어떠세요? 조용한 2인 가족이고 반려동물은 없습니다.' },
      });
      if (r.status < 300) {
        templates.exchange = r.body;
        return;
      }
      if (r.status !== 409) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    throw new Error('exchange dates unavailable');
  });

  // Guides: a free friend booking, and a paid offer left for the guest to accept + pay in the demo.
  const guides = (await must('anon', 'GET', '/v1/search/guides?limit=50')).items.map((g) => g.guide ?? g);
  const gid = (userKey) => guides.find((g) => g.guideId === me(userKey))?.guideId;
  const at = (days, hour) => `${addDays(TODAY, days)}T${String(hour).padStart(2, '0')}:00:00+09:00`;
  // Seeded guide availability covers roughly the next 60 days, 07:00–17:00 KST.
  const guideFlow = async (traveler, guideKey, hours, offer, accept) => {
    for (const off of [24, 25, 26, 31, 33, 38]) {
      const req = await must(traveler, 'POST', '/v1/guide-requests', { guideId: gid(guideKey), startAt: at(off, hours[0]), endAt: at(off, hours[1]), ...offer.request });
      const rid = req.item.id;
      const o = await call(guideKey, 'POST', `/v1/guide-requests/${rid}/offers`, { body: { startAt: at(off, hours[0]), endAt: at(off, hours[1]), ...offer.offer } });
      if (o.status === 409) {
        await call(traveler, 'POST', `/v1/guide-requests/${rid}/cancel`, { body: {} });
        continue;
      }
      if (o.status >= 300) throw new Error(`${o.status} ${JSON.stringify(o.body).slice(0, 200)}`);
      if (!accept) return { req };
      const g = await must(traveler, 'GET', `/v1/guide-requests/${rid}`);
      const offerVersion = g.item?.current_offer_version ?? g.item?.currentOfferVersion ?? 1;
      const acc = await must(traveler, 'POST', `/v1/guide-requests/${rid}/accept`, { offerVersion }, idem(`demo-accept-${rid}`));
      return { req, offer: o.body, accept: acc };
    }
    throw new Error('guide unavailable on all tried days');
  };
  if (gid('guide')) {
    await step('guide request (free) → offer → accept', async () => {
      const r = await guideFlow('guest', 'guide', [10, 13], {
        request: { partySize: 2, city: 'Seoul', languages: ['ko', 'en'], interests: ['cafe', 'food', 'walking'], message: '성수동 카페 골목과 서울숲 근처를 현지인처럼 걸어보고 싶어요!' },
        offer: { paid: false, itinerary: '10:00 성수역 3번 출구 → 카페 골목 → 수제화 거리 → 서울숲 산책 → 13:00 브런치' },
      }, true);
      Object.assign(templates, { guideRequest: r.req, guideOffer: r.offer, guideAccept: r.accept });
    });
  }
  if (gid('proGuide')) {
    await step('guide request (paid) → offer pending', () =>
      guideFlow('guest', 'proGuide', [9, 13], {
        request: { partySize: 2, city: 'Seoul', languages: ['ko'], interests: ['history', 'palace'], message: '경복궁과 창덕궁 후원을 역사 해설과 함께 둘러보고 싶습니다.' },
        offer: { paid: true, priceMinor: 200000, itinerary: '09:00 광화문 → 경복궁 해설 → 북촌 점심 → 창덕궁 후원 특별관람' },
      }, false));
  }

  // Tour order (MOCK payment).
  await step('guest orders a tour + pays', async () => {
    const products = (await must('anon', 'GET', '/v1/travel-products?limit=50')).items;
    for (const prod of products) {
      const deps = (await must('anon', 'GET', `/v1/travel-products/${prod.id}/departures?limit=30`)).items ?? [];
      const dep = deps.find((d) => (d.remaining ?? 10) >= 2 && Date.parse(d.startsAt) > Date.now() + 3 * 86400000);
      if (!dep) continue;
      const order = await must('guest', 'POST', '/v1/orders', { items: [{ departureId: dep.id, qty: 2 }] }, idem(`demo-order-${dep.id}`));
      templates.order = order;
      const oid = order.item?.id ?? order.id;
      const prep = await must('guest', 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: oid }, idem(`demo-prep-${oid}`));
      templates.orderConfirm = await must('guest', 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${prep.orderId}`, orderId: prep.orderId, amount: prep.amount }, idem(`confirm-${prep.orderId}`));
      return;
    }
    throw new Error('no departure with seats');
  });

  log('scenario: waiting for the worker to fan out notifications…');
  await sleep(Number(process.env.SCENARIO_SETTLE_MS || 8000));
}

// ------------------------------------------------------------------------------------------ endpoint discovery
async function walk(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Collect string/template literals containing '/v1/' (template expressions become '{}'). */
function literals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const readTemplate = () => {
    // at char after opening backtick
    let s = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        s += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return s;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '`') {
            i++;
            readTemplate();
            continue;
          } else if (d === "'" || d === '"') {
            const q = d;
            i++;
            while (i < n && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
          }
          i++;
        }
        s += '{}';
        continue;
      }
      s += c;
      i++;
    }
    return s;
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let s = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          s += src[i + 1] ?? '';
          i += 2;
        } else s += src[i++];
      }
      i++;
      if (s.includes('/v1/')) out.push(s);
      continue;
    }
    if (c === '`') {
      i++;
      const s = readTemplate();
      if (s.includes('/v1/')) out.push(s);
      continue;
    }
    i++;
  }
  return out;
}

async function discoverGetTemplates() {
  const oas = JSON.parse(await readFile(path.join(ROOT, 'packages/contracts/openapi.json'), 'utf8'));
  const getTemplates = Object.keys(oas.paths).filter((p) => p.startsWith('/v1/') && oas.paths[p].get);
  const files = [];
  for (const d of ['app', 'components', 'lib']) await walk(path.join(ROOT, 'apps/web', d), files);
  const found = new Set();
  for (const f of files) {
    for (let lit of literals(await readFile(f, 'utf8'))) {
      lit = lit.slice(lit.indexOf('/v1/')).split('?')[0].replace(/\/+$/, '');
      const segs = lit.split('/');
      for (const t of getTemplates) {
        const ts = t.split('/');
        if (ts.length !== segs.length) continue;
        if (ts.every((x, k) => x === segs[k] || (x.startsWith('{') && segs[k].length > 0) || (segs[k] === '{}' && x.startsWith('{')))) {
          // literal segments in the source must not be matched by a '{}' against a literal template segment
          if (ts.every((x, k) => !(segs[k] === '{}' && !x.startsWith('{')))) found.add(t);
        }
      }
    }
  }
  // Skip non-JSON / streaming / side-effect GETs.
  for (const t of ['/v1/realtime/stream', '/v1/admin/settlements/payout-export', '/v1/integrations/ical/{file}', '/v1/seo/redirects']) found.delete(t);
  return { templates: [...found].sort(), oas };
}

// ------------------------------------------------------------------------------------------ recording
const responses = {}; // "<persona>|GET <path>?<sortedQuery>" -> {status, body}
const sortedQuery = (q) => {
  const e = Object.entries(q || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  e.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString();
};
const keyOf = (persona, p, q) => `${persona}|GET ${p}${sortedQuery(q) ? '?' + sortedQuery(q) : ''}`;

let requestCount = 0;
async function record(persona, p, q = {}) {
  const k = keyOf(persona, p, q);
  if (responses[k]) return responses[k];
  const qs = sortedQuery(q);
  const r = await call(persona, 'GET', p + (qs ? '?' + qs : ''));
  requestCount++;
  responses[k] = { status: r.status, body: r.body };
  return responses[k];
}

async function pool(items, fn, n = CONCURRENCY) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const itemsOf = (b) => (Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : Array.isArray(b?.data) ? b.data : Array.isArray(b?.item) ? b.item : []);

/** Curated query variants for endpoints whose results depend on parameters the UI sends. */
function variants(t) {
  const cal = { from: TODAY, to: addDays(TODAY, 365) };
  switch (t) {
    case '/v1/search/properties': {
      const out = [{}, { limit: 12, sort: 'relevance' }, { limit: 24, page: 1, sort: 'relevance' }, { limit: 24, page: 2, sort: 'relevance' }, { limit: 50 }, { limit: 50, page: 2 }];
      const ranges = [[], [addDays(TODAY, 14), addDays(TODAY, 17)], [addDays(TODAY, 30), addDays(TODAY, 60)]];
      for (const city of ['서울', 'Seoul', '제주', 'Jeju', '부산', 'Busan', '강릉', 'Gangneung', '경주', 'Gyeongju', '속초', 'Sokcho', '전주', 'Jeonju', '여수', 'Yeosu']) {
        for (const [ci, co] of ranges) out.push({ q: city, checkIn: ci, checkOut: co, page: 1, limit: 24, sort: 'relevance' });
        out.push({ q: city, guests: 2, page: 1, limit: 24, sort: 'relevance' });
      }
      for (const sort of ['price_asc', 'price_desc', 'rating']) out.push({ page: 1, limit: 24, sort });
      out.push({ mode: 'exchange', page: 1, limit: 24, sort: 'relevance' }, { mode: 'rental', page: 1, limit: 24, sort: 'relevance' });
      return out;
    }
    case '/v1/search/guides':
      return [{}, { limit: 12 }, { limit: 24 }, { city: 'Seoul', limit: 24 }, { city: '서울', limit: 24 }];
    case '/v1/travel-products':
      return [{}, { limit: 12 }, { limit: 50 }, { q: 'Jeju', limit: 50 }];
    case '/v1/content/{type}':
      return null; // expanded with params
    case '/v1/notifications':
      return [{}, { limit: 50 }, { unread: 'true' }];
    case '/v1/host/reservations':
      return [{}, { filter: 'upcoming', limit: 50 }, { filter: 'current', limit: 50 }, { filter: 'completed', limit: 50 }, { filter: 'cancelled', limit: 50 }];
    case '/v1/guide-requests':
      return [{}, { role: 'traveler' }, { role: 'guide' }, { role: 'open' }];
    case '/v1/guide-bookings':
      return [{}, { role: 'traveler' }, { role: 'guide' }];
    case '/v1/provider/settlements':
      return [{}, { limit: 12 }, { limit: 24 }];
    case '/v1/properties/{id}/calendar':
      return [cal];
    case '/v1/host/calendar':
      return null;
    case '/v1/guides/{id}/availability':
      return [{ from: `${TODAY}T00:00:00Z`, to: `${addDays(TODAY, 60)}T00:00:00Z` }, { from: `${TODAY}T00:00:00Z`, to: `${addDays(TODAY, 90)}T00:00:00Z` }];
    case '/v1/travel-products/{id}/departures':
      return [{}, { limit: 30 }];
    case '/v1/conversations/{id}/messages':
      return [{}, { limit: 50 }];
    case '/v1/finance/quote':
      return [];
    case '/v1/reviews':
      return null;
    case '/v1/geo/geocode':
    case '/v1/geo/reverse':
    case '/v1/search/suggest':
      return null;
    default:
      return [{}];
  }
}

const PUBLIC_COLLECTIONS = ['properties', 'guides', 'travel-products', 'content', 'hosts', 'reviews', 'users'];

async function recordAll(templates) {
  const personas = ['anon', ...Object.keys(sessions)];
  const ids = {}; // collection segment -> Set ids (per persona + public)
  const add = (persona, coll, id) => {
    if (!id || typeof id !== 'string') return;
    const k = `${persona}:${coll}`;
    (ids[k] ||= new Set()).add(id);
  };
  const harvest = (persona, p, body) => {
    const coll = p.split('/').filter(Boolean).at(-1);
    for (const it of itemsOf(body)) {
      const o = it?.guide ?? it?.property ?? it;
      if (coll === 'guides' || p === '/v1/search/guides') add(persona, 'guides', o.guideId ?? o.userId ?? o.id);
      else if (p === '/v1/search/properties' || p === '/v1/exchange/homes' || p === '/v1/host/properties' || p === '/v1/favorites') {
        add(persona, 'properties', o.id ?? o.propertyId ?? o.targetId);
        if (o.slug) add(persona, 'by-slug', o.slug);
        if (o.hostId) add(persona, 'hosts', o.hostId);
      } else if (p.startsWith('/v1/content/')) {
        if (o.slug) add(persona, `content:${p.split('/')[3]}`, o.slug);
      } else if (o?.id) add(persona, coll, o.id);
      if (o?.conversationId) add(persona, 'conversations', o.conversationId);
      if (o?.paymentId) add(persona, 'payments', o.paymentId);
    }
  };

  // 1) parameterless GETs for every persona
  const plain = templates.filter((t) => !t.includes('{'));
  const jobs = [];
  for (const persona of personas) for (const t of plain) for (const q of variants(t) ?? []) jobs.push([persona, t, q]);
  // content types used by the web
  for (const persona of personas) for (const type of ['page', 'story', 'destination', 'faq', 'charter']) for (const q of [{}, { limit: 24 }, { limit: 50 }]) jobs.push([persona, `/v1/content/${type}`, q]);
  log(`recording ${jobs.length} list/singleton requests…`);
  await pool(jobs, async ([persona, t, q]) => {
    const r = await record(persona, t, q);
    if (r.status < 300) harvest(persona, t, r.body);
  });

  // 2) detail GETs
  const idList = (persona, coll) => [...new Set([...(ids[`${persona}:${coll}`] ?? []), ...(PUBLIC_COLLECTIONS.includes(coll) || coll === 'by-slug' || coll.startsWith('content:') ? ids[`anon:${coll}`] ?? [] : [])])];
  // admin sees everything; also let detail endpoints for private collections use the admin harvest for admin
  const detailJobs = [];
  const parametric = templates.filter((t) => t.includes('{'));
  for (const persona of personas) {
    for (const t of parametric) {
      const segs = t.split('/');
      const params = segs.filter((s) => s.startsWith('{'));
      if (params.length !== 1) continue;
      const pi = segs.findIndex((s) => s.startsWith('{'));
      const prev = segs[pi - 1];
      let values = [];
      if (t === '/v1/properties/by-slug/{slug}') values = idList(persona, 'by-slug');
      else if (t === '/v1/content/{type}') continue;
      else if (prev === 'users') values = Object.values(sessions).map((s) => s.user?.id).filter(Boolean);
      else values = idList(persona, prev);
      const qs = variants(t);
      if (qs === null) continue;
      for (const v of values) for (const q of qs) detailJobs.push([persona, t.replace(segs[pi], encodeURIComponent(v)), q]);
    }
    // content/{type}/{slug}
    for (const type of ['story', 'destination', 'page', 'faq']) for (const slug of idList(persona, `content:${type}`)) detailJobs.push([persona, `/v1/content/${type}/${encodeURIComponent(slug)}`, {}]);
    // reviews for each property; host calendars
    for (const id of idList(persona, 'properties')) detailJobs.push([persona, '/v1/reviews', { targetType: 'PROPERTY', targetId: id, limit: 6 }]);
    for (const id of ids[`${persona}:properties`] ?? []) {
      if (persona === 'anon') continue;
      detailJobs.push([persona, '/v1/host/calendar', { propertyId: id, from: addDays(TODAY, -7), to: addDays(TODAY, 180) }]);
    }
  }
  log(`recording ${detailJobs.length} detail requests…`);
  await pool(detailJobs, async ([persona, p, q]) => {
    const r = await record(persona, p, q);
    if (r.status < 300 && /\/v1\/(conversations|payments)\b/.test(p)) harvest(persona, p, r.body);
  });

  // 3) second-level details discovered in step 2 (messages of conversations, refunds of payments)
  const more = [];
  for (const persona of personas) {
    for (const cid of ids[`${persona}:conversations`] ?? []) for (const q of [{}, { limit: 50 }]) more.push([persona, `/v1/conversations/${cid}/messages`, q]);
    for (const pid of ids[`${persona}:payments`] ?? []) more.push([persona, `/v1/payments/${pid}`, {}], [persona, `/v1/payments/${pid}/refunds`, {}]);
  }
  await pool(more, async ([persona, p, q]) => void (await record(persona, p, q)));
  return ids;
}

// ------------------------------------------------------------------------------------------ scrub + write
const SECRET_KEY = /^(access_?token|refresh_?token|id_?token|token|secret|password|password_?hash|otpauth_?url|recovery_?codes|client_?secret|api_?key|signing_?secret|ical_?token|export_?token|session_?token)$/i;
// Not secrets (MOCK provider values), but high-entropy "*Key" strings trip secret scanners (gitleaks generic-api-key).
const PLACEHOLDER = { customerKey: 'JPU_demo', paymentKey: 'mock_payment', clientKey: 'mock_client_key' };
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && x !== null && typeof x !== 'boolean') o[k] = typeof x === 'string' ? '[redacted]' : null;
      else if (k in PLACEHOLDER && typeof x === 'string') o[k] = PLACEHOLDER[k];
      else o[k] = scrub(x);
    }
    return o;
  }
  if (typeof v === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return '[redacted-jwt]';
  return v;
}

async function main() {
  log(`API ${API} → ${path.relative(ROOT, OUT)}`);
  const health = await raw('GET', '/health').catch(() => null);
  if (!health || health.status !== 200) throw new Error(`API not reachable at ${API}`);
  await loginAll();
  if (SCENARIO) await runScenario();
  const { templates: tpls } = await discoverGetTemplates();
  log(`discovered ${tpls.length} GET endpoint templates used by the web`);
  const ids = await recordAll(tpls);

  // ids for the static build (generateStaticParams)
  const all = (coll) => [...new Set(Object.entries(ids).filter(([k]) => k.split(':').slice(1).join(':') === coll).flatMap(([, s]) => [...s]))].sort();
  const personaIds = (persona, coll) => [...(ids[`${persona}:${coll}`] ?? [])].sort();
  const out = {
    version: 1,
    recordedAt: new Date().toISOString(),
    recordedFrom: API.replace(/\/\/[^/@]*@/, '//'),
    password: PASSWORD,
    personas: Object.fromEntries(
      Object.entries(sessions).map(([k, s]) => [
        k,
        { email: s.email, userId: s.user?.id, displayName: s.user?.displayName, roles: s.user?.roles ?? [], aal: s.aal, login: scrub({ ...s.login, aal: s.aal }) },
      ]),
    ),
    ids: {
      propertySlugs: all('by-slug'),
      propertyIds: all('properties'),
      hostPropertyIds: [...new Set([...personaIds('host', 'properties'), ...personaIds('hostJeju', 'properties'), ...personaIds('exchange', 'properties')])].sort(),
      storySlugs: all('content:story'),
      travelProductIds: all('travel-products'),
      guideIds: all('guides'),
      exchangeIds: all('exchanges'),
      reservationIds: all('reservations'),
      orderIds: all('orders'),
      guideBookingIds: all('guide-bookings'),
      guideRequestIds: all('guide-requests'),
      conversationIds: all('conversations'),
      hostIds: all('hosts'),
    },
    idPool: Object.fromEntries(['reservation', 'exchange', 'order', 'guideBooking', 'guideRequest', 'property', 'conversation', 'payment', 'quote', 'hold'].map((k) => [k, Array.from({ length: 30 }, (_, i) => poolUuid(k, i))])),
    templates: scrub(templates),
    bodies: {},
    responses: {},
  };
  // body table (dedupe identical bodies)
  for (const [k, r] of Object.entries(responses).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const body = scrub(r.body);
    const json = JSON.stringify(body);
    const h = createHash('sha1').update(json).digest('hex').slice(0, 12);
    out.bodies[h] ??= body;
    out.responses[k] = { status: r.status, body: h };
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  const text = JSON.stringify(out);
  await writeFile(OUT, text);
  const statuses = Object.values(out.responses).reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  log(`${requestCount} requests, ${Object.keys(out.responses).length} responses, ${Object.keys(out.bodies).length} unique bodies, ${(text.length / 1048576).toFixed(2)} MB`);
  log('statuses', JSON.stringify(statuses));
  log('ids', JSON.stringify(Object.fromEntries(Object.entries(out.ids).map(([k, v]) => [k, v.length]))));
  if (text.length > 15 * 1048576) warn('fixture file exceeds 15 MB');
}

main().catch((e) => {
  console.error('[record] FAILED', e);
  process.exit(1);
});
