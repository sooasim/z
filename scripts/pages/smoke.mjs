#!/usr/bin/env node
/**
 * Smoke test for the static Pages demo (dist-pages/) — serves it under the basePath like GitHub Pages and
 * clicks through the core flows with Playwright (Chromium).
 *   node scripts/pages/smoke.mjs [--base /z] [--port 4199] [--shots dir] [--headed]
 * Needs `playwright` resolvable (PLAYWRIGHT_MODULE=/path/to/node_modules/playwright to override).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const rawBase = opt('base', process.env.NEXT_BASE_PATH ?? '/z');
const BASE = rawBase === '/' || rawBase === '' ? '' : '/' + rawBase.replace(/^\/+|\/+$/g, '');
const PORT = Number(opt('port', '4199'));
const SHOTS = opt('shots', '');
const URL0 = `http://localhost:${PORT}${BASE}`;
const require = createRequire(import.meta.url);
const pw = (() => {
  for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
    try {
      return require(m);
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found (set PLAYWRIGHT_MODULE)');
})();

const plus = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/pages/serve.mjs'), '--port', String(PORT), '--base', BASE || '/'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
if (SHOTS) await mkdir(SHOTS, { recursive: true });

const browser = await pw.chromium.launch({ headless: !args.includes('--headed') });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
const page = await ctx.newPage();
const problems = [];
const warnings = [];
// React recovers from hydration mismatches (#418/#423/#425) by client-rendering the subtree: report, don't fail.
page.on('pageerror', (e) => (/Minified React error #4(18|19|21|22|23|25)\b/.test(e.message) ? warnings : problems).push(`pageerror @${page.url().replace(URL0, '')}: ${e.message.slice(0, 160)}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET|tile\.openstreetmap|cdn\.jsdelivr|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('response', (r) => {
  const u = r.url();
  if (r.status() >= 400 && u.startsWith(`http://localhost:${PORT}`) && !u.includes('/__demo_api/')) problems.push(`http ${r.status()} ${u}`);
});
const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, e.message.split('\n')[0]);
    await shot(`fail-${name.replace(/\W+/g, '_')}`);
  }
};

// Expectations come from the recorded fixtures, so the test follows whatever the seed contains.
const fx = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'packages/demo/fixtures/api.json'), 'utf8'));
const body = (k) => fx.bodies[fx.responses[k]?.body];
const listings = new Map();
for (const [k, r] of Object.entries(fx.responses)) if (k.startsWith('anon|GET /v1/search/properties') && r.status === 200) for (const it of fx.bodies[r.body]?.items ?? []) listings.set(it.id, it);
const L = [...listings.values()];
const detail = (p) => body(`anon|GET /v1/properties/by-slug/${p.slug}`)?.item ?? {};
const inCity = (re) => L.filter((p) => re.test(p.city ?? ''));
const reTitle = (list) => new RegExp(list.map((p) => p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
const jeju = inCity(/jeju/i);
const busan = inCity(/busan/i);
const seoul = inCity(/seoul/i);
const hostJejuId = fx.personas.hostJeju?.userId;
const bookable = L.filter((p) => p.rentalEnabled && p.paidBookingEnabled && detail(p).host?.id === hostJejuId && (detail(p).minNights ?? 1) <= 3 && (p.maxGuests ?? 2) >= 2);
const target = bookable[0];
const guestTrips = (body('guest|GET /v1/reservations')?.items ?? []).map((r) => listings.get(r.propertyId)).filter(Boolean);
const favTitles = (body('guest|GET /v1/favorites')?.items ?? []).map((f) => f.target?.title).filter(Boolean);
const as = (persona) => page.evaluate((p) => localStorage.setItem('jpdemo:session:v1', JSON.stringify({ persona: p, aal: 'aal1', sid: 'smoke', at: new Date().toISOString() })), persona);

try {
  await step('home loads with listings', async () => {
    await page.goto(`${URL0}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.lcard').nth(4).waitFor({ timeout: 15000 });
    await page.getByText(reTitle(L)).first().waitFor({ timeout: 15000 });
    const n = await page.locator('.lcard').count();
    await page.locator('#jetpool-demo-ribbon').waitFor({ state: 'attached', timeout: 10000 });
    const ribbon = await page.locator('#jetpool-demo-ribbon').count();
    check('home loads with listings', n >= 6 && ribbon === 1, `${n} cards, ribbon=${ribbon}`);
    await shot('01-home');
  });

  await step('search works', async () => {
    await page.goto(`${URL0}/stay/?q=${encodeURIComponent('제주')}`, { waitUntil: 'domcontentloaded' });
    await page.getByText(reTitle(jeju)).first().waitFor({ timeout: 15000 });
    const nJeju = await page.locator('.grid .lcard').count();
    await page.goto(`${URL0}/stay/?q=Busan`, { waitUntil: 'domcontentloaded' });
    await page.getByText(reTitle(busan)).first().waitFor({ timeout: 15000 });
    const leaked = seoul.length ? await page.locator('.grid').getByText(reTitle(seoul)).count() : 0;
    check('search works', nJeju >= Math.min(2, jeju.length) && leaked === 0, `제주 → ${nJeju} stays; Busan → no Seoul listings`);
    await shot('02-search');
  });

  await step('listing detail opens', async () => {
    await page.locator('.grid .lcard a, .grid a.lcard').first().click();
    await page.waitForURL(/\/stay\/[^/?]+\/?/, { timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    const h1 = (await page.locator('h1').first().innerText()).trim();
    check('listing detail opens', h1.length > 1, `${h1} @ ${page.url().replace(URL0, '')}`);
    await shot('03-detail');
  });

  await step('login as guest', async () => {
    await page.goto(`${URL0}/login/`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=email]').first().fill('guest@jetpool.dev');
    await page.locator('input[type=password]').first().fill(fx.password || 'Jetpool!2026dev');
    await page.locator('form button[type=submit], form button.primary').first().click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 });
    await page.waitForTimeout(800);
    const loginLinks = await page.locator('header >> text=로그인').count();
    check('login as guest', loginLinks === 0, `landed on ${page.url().replace(URL0, '')}`);
    await shot('04-after-login');
  });

  await step('trips shows the seeded reservation', async () => {
    await page.goto(`${URL0}/trips/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(reTitle(guestTrips)).first().waitFor({ timeout: 15000 });
    const txt = await page.locator('main').innerText();
    check('trips shows the seeded reservation', reTitle(guestTrips).test(txt), `${guestTrips.length} recorded stays, e.g. ${txt.match(reTitle(guestTrips))?.[0]}`);
    await shot('05-trips');
  });

  await step('book a stay end-to-end (MOCK payment)', async () => {
    if (!target) throw new Error('no bookable Jeju-host listing in fixtures');
    // first free 3-night window ≥ 30 days out according to the recorded calendar
    const cal = body(Object.keys(fx.responses).find((k) => k.startsWith(`anon|GET /v1/properties/${target.id}/calendar`)))?.item?.days ?? [];
    const free = new Set(cal.filter((d) => d.status === 'available').map((d) => d.date));
    let ci = plus(30);
    for (let o = 30; o < 300; o++) if ([0, 1, 2].every((k) => free.has(plus(o + k)))) { ci = plus(o); break; }
    const co = new Date(Date.parse(ci + 'T00:00:00Z') + 3 * 86400000).toISOString().slice(0, 10);
    await page.goto(`${URL0}/stay/${target.slug}/?checkIn=${ci}&checkOut=${co}&guests=2`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/총|합계|Total/).first().waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /예약하기|예약 요청|Reserve|예약/ }).first().click();
    await page.waitForURL(/\/checkout\/?\?/, { timeout: 15000 });
    await page.locator('input[type=checkbox]').first().check();
    await page.getByRole('button', { name: /날짜 확보|Hold dates/ }).click();
    await page.getByRole('button', { name: /결제하기|Pay now/ }).waitFor({ timeout: 15000 });
    await shot('06-checkout-pay');
    await page.getByRole('button', { name: /결제하기|Pay now/ }).click();
    await page.waitForURL(/\/checkout\/success\//, { timeout: 15000 });
    await page.getByText(/결제가 승인되었|Payment approved/).waitFor({ timeout: 15000 });
    await shot('07-paid');
    await page.getByRole('link', { name: /예약 상세|예약\/주문 상세 보기|Booking details|View booking/ }).click();
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}\/?/, { timeout: 15000 });
    await page.getByText(target.title).first().waitFor({ timeout: 15000 });
    const txt = await page.locator('main').innerText();
    check('book a stay end-to-end (MOCK payment)', /확정|CONFIRMED/i.test(txt), `${target.title} ${ci}→${co} ${page.url().replace(URL0, '')}`);
    await shot('08-trip-detail');
  });

  await step('messages + favorites', async () => {
    await page.goto(`${URL0}/messages/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(new RegExp(fx.personas.host.displayName)).first().waitFor({ timeout: 15000 });
    await page.goto(`${URL0}/saved/`, { waitUntil: 'domcontentloaded' });
    if (favTitles.length) await page.getByText(new RegExp(favTitles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))).first().waitFor({ timeout: 15000 });
    check('messages + favorites', true, `${favTitles.length} saved`);
  });

  await step('host sees the new booking after persona switch', async () => {
    await as('hostJeju');
    await page.goto(`${URL0}/host/reservations/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(fx.personas.guest.displayName).first().waitFor({ timeout: 15000 });
    const txt = await page.locator('main').innerText();
    check('host sees the new booking after persona switch', target ? txt.includes(target.title) : false);
    await shot('09-host-reservations');
  });

  const requested = fx.ids.exchangeIds.find((id) => fx.bodies[fx.responses[`host|GET /v1/exchanges/${id}`]?.body]?.item?.status === 'REQUESTED');
  if (requested) {
    await step('host accepts a home exchange', async () => {
      await as('host');
      await page.goto(`${URL0}/exchange/${requested}/`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /이 조건으로 수락|조건 수락|Accept these terms|Accept v/ }).click();
      await page.getByText(/안전 수칙|Verification|검증/).first().waitFor({ timeout: 15000 });
      check('host accepts a home exchange', true);
    });
  }

  await step('tour order paid (MOCK)', async () => {
    await as('guest');
    const tp = fx.ids.travelProductIds.find((id) => (body(`anon|GET /v1/travel-products/${id}/departures?limit=30`)?.items ?? []).length >= 2) ?? fx.ids.travelProductIds[0];
    await page.goto(`${URL0}/travel/${tp}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=radio][name=dep]').nth(1).check({ timeout: 15000 });
    await page.getByRole('button', { name: /예약하기|Book now/ }).click();
    await page.getByRole('button', { name: /결제하기|Pay now/ }).click({ timeout: 15000 });
    await page.getByText(/결제가 승인되었|Payment approved/).waitFor({ timeout: 15000 });
    await page.getByRole('link', { name: /주문 상세|상세 보기|Order & vouchers|View booking/ }).click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}\/?/, { timeout: 15000 });
    await page.getByText(/결제 완료|PAID/).first().waitFor({ timeout: 15000 });
    check('tour order paid (MOCK)', true, page.url().replace(URL0, ''));
    await shot('10-order');
  });

  await step('cancel a stay with refund preview', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rid = (body('guest|GET /v1/reservations')?.items ?? []).find((r) => r.status === 'CONFIRMED' && r.checkIn > today)?.id;
    if (!rid) throw new Error('guest has no upcoming confirmed stay in fixtures');
    await page.goto(`${URL0}/trips/${rid}/manage/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/환불 예정액|Refund/).first().waitFor({ timeout: 15000 });
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /예약 취소|Cancel reservation/ }).click();
    await page.waitForTimeout(1200);
    await page.goto(`${URL0}/trips/${rid}/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/환불|취소|Refund|Cancel/).first().waitFor({ timeout: 15000 });
    check('cancel a stay with refund preview', true);
  });
} finally {
  const uniq = [...new Set(problems)];
  check('no page errors / broken same-origin assets', uniq.length === 0, uniq.slice(0, 8).join(' | '));
  if (warnings.length) console.log(`  (warn) ${warnings.length} recoverable hydration mismatch(es): ${[...new Set(warnings)].slice(0, 3).join(' | ')}`);
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
