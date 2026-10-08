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
page.on('pageerror', (e) => problems.push(`pageerror @${page.url().replace(URL0, '')}: ${e.message.slice(0, 160)}`));
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

try {
  await step('home loads with listings', async () => {
    await page.goto(`${URL0}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.lcard h3, .lcard .title, .lcard').nth(4).waitFor({ timeout: 15000 });
    await page.getByText('북촌 한옥 스테이').first().waitFor({ timeout: 15000 });
    const n = await page.locator('.lcard').count();
    await page.locator('#jetpool-demo-ribbon').waitFor({ state: 'attached', timeout: 10000 });
    const ribbon = await page.locator('#jetpool-demo-ribbon').count();
    check('home loads with listings', n >= 6 && ribbon === 1, `${n} cards, ribbon=${ribbon}`);
    await shot('01-home');
  });

  await step('search works', async () => {
    await page.goto(`${URL0}/stay/?q=${encodeURIComponent('제주')}`, { waitUntil: 'domcontentloaded' });
    await page.getByText('애월 오션뷰 빌라').first().waitFor({ timeout: 15000 });
    const jeju = await page.locator('.grid .lcard').count();
    await page.goto(`${URL0}/stay/?q=Busan`, { waitUntil: 'domcontentloaded' });
    await page.getByText('광안리 오션뷰 아파트').first().waitFor({ timeout: 15000 });
    const hasSeoul = await page.getByText('북촌 한옥 스테이').count();
    check('search works', jeju >= 2 && hasSeoul === 0, `제주 → ${jeju} stays; Busan excludes Seoul`);
    await shot('02-search');
  });

  let detailUrl = '';
  await step('listing detail opens', async () => {
    await page.locator('.grid .lcard a, .grid a.lcard').first().click();
    await page.waitForURL(/\/stay\/[^/?]+\/?/, { timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    const h1 = (await page.locator('h1').first().innerText()).trim();
    detailUrl = page.url();
    check('listing detail opens', h1.length > 1, `${h1} @ ${detailUrl.replace(URL0, '')}`);
    await shot('03-detail');
  });

  await step('login as guest', async () => {
    await page.goto(`${URL0}/login/`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=email]').first().fill('guest@jetpool.dev');
    await page.locator('input[type=password]').first().fill('Jetpool!2026dev');
    await page.locator('form button[type=submit], form button.primary').first().click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 });
    await page.waitForTimeout(800);
    const loginLinks = await page.locator('header >> text=로그인').count();
    check('login as guest', loginLinks === 0, `landed on ${page.url().replace(URL0, '')}`);
    await shot('04-after-login');
  });

  await step('trips shows the seeded reservation', async () => {
    await page.goto(`${URL0}/trips/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/북촌 한옥 스테이|애월 오션뷰 빌라|강릉 안목 커피거리 바다집/).first().waitFor({ timeout: 15000 });
    const txt = await page.locator('main').innerText();
    check('trips shows the seeded reservation', /북촌 한옥 스테이|애월 오션뷰 빌라|강릉/.test(txt) && /확정|CONFIRMED/i.test(txt), txt.match(/북촌 한옥 스테이|애월 오션뷰 빌라|강릉[^\n]*/)?.[0] ?? '');
    await shot('05-trips');
  });

  await step('book a stay end-to-end (MOCK payment)', async () => {
    const ci = plus(40);
    const co = plus(43);
    await page.goto(`${URL0}/stay/jeju-stone-house/?checkIn=${ci}&checkOut=${co}&guests=2`, { waitUntil: 'domcontentloaded' });
    const reserve = page.getByRole('button', { name: /예약하기|예약 요청|Reserve|예약/ }).first();
    await page.getByText(/총|합계|Total/).first().waitFor({ timeout: 15000 });
    await reserve.click();
    await page.waitForURL(/\/checkout\/?\?/, { timeout: 15000 });
    await page.locator('input[type=checkbox]').first().check();
    await page.getByRole('button', { name: /날짜 확보|Hold dates/ }).click();
    await page.getByRole('button', { name: /결제하기|Pay now/ }).waitFor({ timeout: 15000 });
    await shot('06-checkout-pay');
    await page.getByRole('button', { name: /결제하기|Pay now/ }).click();
    await page.waitForURL(/\/checkout\/success\//, { timeout: 15000 });
    await page.getByText(/결제가 승인되었습니다|Payment approved/).waitFor({ timeout: 15000 });
    await shot('07-paid');
    await page.getByRole('link', { name: /예약\/주문 상세 보기|View booking/ }).click();
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}\/?/, { timeout: 15000 });
    await page.getByText('서귀포 돌담 독채').first().waitFor({ timeout: 15000 });
    const txt = await page.locator('main').innerText();
    check('book a stay end-to-end (MOCK payment)', /확정|CONFIRMED/i.test(txt), page.url().replace(URL0, ''));
    await shot('08-trip-detail');
  });

  await step('messages + favorites', async () => {
    await page.goto(`${URL0}/messages/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/서울 호스트/).first().waitFor({ timeout: 15000 });
    await page.goto(`${URL0}/saved/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/경주 황리단길 한옥|강릉 안목/).first().waitFor({ timeout: 15000 });
    check('messages + favorites', true);
  });

  await step('host sees the new booking after persona switch', async () => {
    await page.evaluate(() => {
      localStorage.setItem('jpdemo:session:v1', JSON.stringify({ persona: 'hostJeju', aal: 'aal1', sid: 'smoke', at: new Date().toISOString() }));
    });
    await page.goto(`${URL0}/host/reservations/`, { waitUntil: 'domcontentloaded' });
    await page.getByText('서귀포 돌담 독채').first().waitFor({ timeout: 15000 });
    const txt = await page.locator('main').innerText();
    check('host sees the new booking after persona switch', /여행자 김/.test(txt));
    await shot('09-host-reservations');
  });

  const fx = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'packages/demo/fixtures/api.json'), 'utf8'));
  const as = (persona) => page.evaluate((p) => localStorage.setItem('jpdemo:session:v1', JSON.stringify({ persona: p, aal: 'aal1', sid: 'smoke', at: new Date().toISOString() })), persona);
  const requested = fx.ids.exchangeIds.find((id) => fx.bodies[fx.responses[`host|GET /v1/exchanges/${id}`]?.body]?.item?.status === 'REQUESTED');
  if (requested) {
    await step('host accepts a home exchange', async () => {
      await as('host');
      await page.goto(`${URL0}/exchange/${requested}/`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /조건 수락|Accept v/ }).click();
      await page.getByText(/안전 수칙|Verification|검증/).first().waitFor({ timeout: 15000 });
      check('host accepts a home exchange', true);
    });
  }

  await step('tour order paid (MOCK)', async () => {
    await as('guest');
    await page.goto(`${URL0}/travel/${fx.ids.travelProductIds[0]}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=radio][name=dep]').nth(1).check({ timeout: 15000 });
    await page.getByRole('button', { name: /예약하기|Book now/ }).click();
    await page.getByRole('button', { name: /결제하기|Pay now/ }).click({ timeout: 15000 });
    await page.getByText(/결제가 승인되었습니다|Payment approved/).waitFor({ timeout: 15000 });
    await page.getByRole('link', { name: /상세 보기|View booking/ }).click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}\/?/, { timeout: 15000 });
    await page.getByText(/결제 완료|PAID/).first().waitFor({ timeout: 15000 });
    check('tour order paid (MOCK)', true, page.url().replace(URL0, ''));
    await shot('10-order');
  });

  await step('cancel a stay with refund preview', async () => {
    const rid = fx.ids.reservationIds[0];
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
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
