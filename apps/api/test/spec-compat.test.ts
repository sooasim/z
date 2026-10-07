/**
 * Spec traceability (G0): compatibility views for spec table names (migration 0900), the
 * docs/SPEC_TABLE_MAPPING.md mapping and scripts/validate-spec.mjs, plus the exchange → TRUST-03 dispute
 * contract (disputeExchange delegates to openDispute).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { recordTransition } from '../src/platform/fsm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPAT_MIGRATION = '0900_spec_compat_views.sql';

/** Spec names this traceability task owns (views in 0900 + the in-memory geo cache). */
const OWNED = [
  'fee_rules', 'tax_rules', 'receipt_records', 'exchange_eligibility', 'agreement_acceptances', 'exchange_state_history',
  'guide_languages', 'guide_specialties', 'guide_time_blocks', 'guide_search_projection', 'guide_booking_history',
  'travel_inventory', 'itinerary_days', 'itinerary_activities', 'charter_content', 'payment_attempts', 'payouts',
  'search_projection_offsets', 'geo_cache',
];
/** Spec tables created as real tables by the platform/ops migrations 0800/0801 (other owners). */
const PLATFORM_OPS_TABLES = ['risk_events', 'security_incidents', 'config_versions', 'dead_letters', 'admin_saved_views', 'support_case_links', 'cms_external_refs'];

interface MappingEntry { kind: 'view' | 'table' | 'column' | 'in-memory'; implementation: string; tables: string[]; satisfied: boolean; problem: string | null }
interface G0Report { ok: boolean; warnings: string[]; errors: string[]; info: string[]; missingTables: string[]; tableMapping: Record<string, MappingEntry> }

function runValidateSpec(): { status: number | null; stdout: string; report: G0Report } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jp-g0-'));
  const out = path.join(dir, 'g0.json');
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-spec.mjs'), '--json', out], { cwd: ROOT, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout + r.stderr, report: JSON.parse(readFileSync(out, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const compatViews = () =>
  [...readFileSync(path.join(ROOT, 'packages/db/migrations', COMPAT_MIGRATION), 'utf8').matchAll(/^CREATE VIEW (\w+)/gm)].map((m) => m[1]);

let t: TestApp;
let g0: ReturnType<typeof runValidateSpec>;

beforeAll(async () => {
  t = await createTestApp();
  g0 = runValidateSpec();
});
afterAll(async () => t?.close());

const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;

describe('G0 spec table traceability', () => {
  it('0900 defines a view for every owned SQL-backed name, and each one is documented in SPEC_TABLE_MAPPING.md', () => {
    const views = compatViews();
    expect(new Set(views)).toEqual(new Set(OWNED.filter((n) => n !== 'geo_cache')));
    for (const v of views) {
      expect(g0.report.tableMapping[v], v).toMatchObject({ kind: 'view', satisfied: true });
    }
    expect(g0.report.tableMapping.geo_cache).toMatchObject({ kind: 'in-memory', satisfied: true });
    expect(g0.report.tableMapping.geo_cache.implementation).toContain('implemented as in-process cache (non-authoritative)');
  });

  it('every mapped view exists as a read-only view on the migrated DB and SELECT * … LIMIT 1 succeeds', async () => {
    const views = new Set([...compatViews(), ...Object.entries(g0.report.tableMapping).filter(([, e]) => e.kind === 'view').map(([n]) => n)]);
    expect(views.size).toBeGreaterThanOrEqual(18);
    for (const v of views) {
      const kind = await rows(`SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`, [v]);
      expect(kind[0]?.relkind, `${v} should be a view`).toBe('v');
      await expect(t.pool.query(`SELECT * FROM ${v} LIMIT 1`), v).resolves.toBeDefined();
      // backing tables named in the mapping are real tables (or views) in the DB
      for (const b of g0.report.tableMapping[v]?.tables ?? []) {
        expect((await rows(`SELECT to_regclass($1) AS r`, [`public.${b}`]))[0].r, `${v} → ${b}`).not.toBeNull();
      }
    }
  });

  it('validate-spec exits 0 with no "table … not created" warnings', async () => {
    expect(g0.status, g0.stdout).toBe(0);
    expect(g0.report.errors).toEqual([]);
    const notCreated = g0.report.warnings.filter((w) => /table '.*' not created/.test(w));
    const platformOpsPresent = (await rows(`SELECT count(to_regclass('public.' || n))::int AS n FROM unnest($1::text[]) n`, [PLATFORM_OPS_TABLES]))[0].n === PLATFORM_OPS_TABLES.length;
    if (platformOpsPresent) {
      expect(notCreated).toEqual([]);
      expect(g0.report.missingTables).toEqual([]);
    } else {
      // 0800/0801 not merged yet: only the names owned here must be satisfied
      expect(notCreated.filter((w) => OWNED.some((n) => w.includes(`'${n}'`)))).toEqual([]);
    }
    expect(g0.report.warnings.filter((w) => w.includes('SPEC_TABLE_MAPPING'))).toEqual([]);
    expect(g0.report.warnings.filter((w) => w.includes('no route tagged'))).toEqual([]);
  });
});

describe('compat view semantics', () => {
  it('fee_rules / tax_rules partition finance_rules by rule_type', async () => {
    const ids = (await rows(
      `INSERT INTO finance_rules(rule_type, domain, params, effective_from)
       SELECT x, '*', '{"bps":100}'::jsonb, now() FROM unnest(ARRAY['PLATFORM_FEE','HOST_FEE','TAX','WITHHOLDING','EVIDENCE']) x RETURNING id`,
    )).map((r) => r.id);
    const fee = await rows(`SELECT rule_type FROM fee_rules WHERE id = ANY($1::uuid[]) ORDER BY rule_type`, [ids]);
    const tax = await rows(`SELECT rule_type FROM tax_rules WHERE id = ANY($1::uuid[]) ORDER BY rule_type`, [ids]);
    expect(fee.map((r) => r.rule_type)).toEqual(['HOST_FEE', 'PLATFORM_FEE']);
    expect(tax.map((r) => r.rule_type)).toEqual(['EVIDENCE', 'TAX', 'WITHHOLDING']);
  });

  it('guide views: languages/specialties unnest, time blocks, search projection, booking history', async () => {
    const g = await createUser(t, { verified: true, displayName: 'Guide One' });
    const friend = await createUser(t, { verified: true });
    const draft = await createUser(t, { verified: true });
    const traveler = await createUser(t, { verified: true });
    await t.pool.query(
      `INSERT INTO guide_profiles(user_id, guide_type, languages, specialties, lat, lng, city, status, verification_status, paid_enabled, hourly_price_minor)
       VALUES ($1,'PAID',ARRAY['ko','en'],ARRAY['food','history'],37.566535,126.977969,'Seoul','PUBLISHED','VERIFIED',true,30000),
              ($2,'FRIEND',ARRAY['ja'],'{}',NULL,NULL,'Busan','PUBLISHED','PENDING',false,5000),
              ($3,'FRIEND',ARRAY['en'],'{}',NULL,NULL,'Seoul','DRAFT','PENDING',false,NULL)`,
      [g.id, friend.id, draft.id],
    );
    expect(await rows(`SELECT language, sort_order FROM guide_languages WHERE guide_id = $1 ORDER BY sort_order`, [g.id])).toEqual([
      { language: 'ko', sort_order: 1 },
      { language: 'en', sort_order: 2 },
    ]);
    expect((await rows(`SELECT specialty FROM guide_specialties WHERE guide_id = $1 ORDER BY sort_order`, [g.id])).map((r) => r.specialty)).toEqual(['food', 'history']);

    const at = (h: number) => new Date(Date.now() + h * 3600_000);
    const [blocked] = await rows(`INSERT INTO guide_availability(guide_id, start_at, end_at, status) VALUES ($1,$2,$3,'BLOCKED'),($1,$4,$5,'AVAILABLE') RETURNING id`, [g.id, at(24), at(26), at(48), at(52)]);
    const [confirmed] = await rows(
      `INSERT INTO guide_bookings(guide_id, traveler_id, guide_type, start_at, end_at, status, paid, price_minor) VALUES ($1,$2,'PAID',$3,$4,'CONFIRMED',true,30000) RETURNING id`,
      [g.id, traveler.id, at(72), at(75)],
    );
    await t.pool.query(`INSERT INTO guide_bookings(guide_id, traveler_id, guide_type, start_at, end_at, status) VALUES ($1,$2,'PAID',$3,$4,'CANCELLED')`, [g.id, traveler.id, at(72), at(75)]);
    const blocks = await rows(`SELECT id, block_type, source_table, booking_status FROM guide_time_blocks WHERE guide_id = $1 ORDER BY start_at`, [g.id]);
    expect(blocks).toEqual([
      { id: blocked.id, block_type: 'BLACKOUT', source_table: 'guide_availability', booking_status: null },
      { id: confirmed.id, block_type: 'BOOKING', source_table: 'guide_bookings', booking_status: 'CONFIRMED' },
    ]);

    await t.pool.query(
      `INSERT INTO reviews(author_id, target_type, target_id, transaction_type, transaction_id, rating, status) VALUES ($1,'GUIDE',$2,'GUIDE_BOOKING',$3,5,'PUBLISHED'),($1,'GUIDE',$2,'GUIDE_BOOKING',$4,1,'HIDDEN')`,
      [traveler.id, g.id, confirmed.id, randomUUID()],
    );
    const proj = await rows(`SELECT * FROM guide_search_projection WHERE guide_id = ANY($1::uuid[]) ORDER BY city`, [[g.id, friend.id, draft.id]]);
    expect(proj.map((p) => p.guide_id)).toEqual([friend.id, g.id]); // DRAFT excluded
    expect(proj[1]).toMatchObject({ display_name: 'Guide One', approx_lat: 37.57, approx_lng: 126.98, hourly_price_minor: 30000, verified: true, review_count: 1 });
    expect(proj[0]).toMatchObject({ paid_enabled: false, hourly_price_minor: null, verified: false });
    expect(Object.keys(proj[0])).not.toContain('lat');

    await withTx(t.pool, (tx) => recordTransition(tx, t.ctx(), { aggregateType: 'GUIDE_BOOKING', aggregateId: confirmed.id, from: 'PAYMENT_PENDING', to: 'CONFIRMED', reason: 'paid' }));
    expect(await rows(`SELECT from_state, to_state, reason FROM guide_booking_history WHERE guide_booking_id = $1`, [confirmed.id])).toEqual([
      { from_state: 'PAYMENT_PENDING', to_state: 'CONFIRMED', reason: 'paid' },
    ]);
  });

  it('travel_inventory exposes remaining / min-participant / sellable; itinerary days & activities', async () => {
    const owner = await createUser(t);
    const [sup] = await rows(`INSERT INTO suppliers(owner_user_id, name, supplier_type, status) VALUES ($1,'Spec Tours','TOUR_OPERATOR','APPROVED') RETURNING id`, [owner.id]);
    const [prod] = await rows(`INSERT INTO travel_products(supplier_id, type, title, status) VALUES ($1,'TOUR','Spec tour','PUBLISHED') RETURNING id`, [sup.id]);
    const deps = await rows(
      `INSERT INTO travel_departures(product_id, starts_at, capacity, booked, min_participants, status) VALUES
         ($1, now() + interval '10 days', 10, 4, 5, 'OPEN'),
         ($1, now() + interval '11 days', 2, 2, 1, 'GUARANTEED'),
         ($1, now() - interval '1 day', 5, 1, 1, 'OPEN') RETURNING id`,
      [prod.id],
    );
    const inv = await rows(`SELECT departure_id, remaining, min_participants_met, sellable, guaranteed FROM travel_inventory WHERE product_id = $1 ORDER BY starts_at DESC`, [prod.id]);
    const byId = new Map(inv.map((r) => [r.departure_id, r]));
    expect(byId.get(deps[0].id)).toMatchObject({ remaining: 6, min_participants_met: false, sellable: true, guaranteed: false });
    expect(byId.get(deps[1].id)).toMatchObject({ remaining: 0, min_participants_met: true, sellable: false, guaranteed: true });
    expect(byId.get(deps[2].id)).toMatchObject({ remaining: 4, sellable: false }); // already started

    const [it0] = await rows(`INSERT INTO itineraries(owner_id, title, start_date, end_date) VALUES ($1,'Trip',$2,$3) RETURNING id`, [owner.id, day(10), day(12)]);
    await t.pool.query(
      `INSERT INTO itinerary_items(itinerary_id, day_index, sort_order, item_type, title, start_time, end_time) VALUES
         ($1,0,0,'NOTE','Arrive','09:00','10:00'), ($1,0,1,'TRAVEL_PRODUCT','Tour','13:00','17:00'), ($1,5,0,'NOTE','Extra day',NULL,NULL)`,
      [it0.id],
    );
    const days = await rows(`SELECT day_index, day_no, to_char(day_date,'YYYY-MM-DD') AS day_date, activity_count FROM itinerary_days WHERE itinerary_id = $1 ORDER BY day_index`, [it0.id]);
    expect(days).toEqual([
      { day_index: 0, day_no: 1, day_date: day(10), activity_count: 2 },
      { day_index: 1, day_no: 2, day_date: day(11), activity_count: 0 },
      { day_index: 2, day_no: 3, day_date: day(12), activity_count: 0 },
      { day_index: 5, day_no: 6, day_date: day(15), activity_count: 1 },
    ]);
    const acts = await rows(`SELECT title, activity_type, day_no FROM itinerary_activities WHERE itinerary_id = $1 ORDER BY day_index, sort_order`, [it0.id]);
    expect(acts).toEqual([
      { title: 'Arrive', activity_type: 'NOTE', day_no: 1 },
      { title: 'Tour', activity_type: 'TRAVEL_PRODUCT', day_no: 1 },
      { title: 'Extra day', activity_type: 'NOTE', day_no: 6 },
    ]);
  });

  it('payment_attempts, payouts and receipt_records project the payment / settlement tables', async () => {
    const payer = await createUser(t);
    const host = await createUser(t);
    const [p] = await rows(
      `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at, failure_code)
       VALUES ('MOCK',$1,$2,'ORDER',$3,'FAILED',1000,'KRW',now() + interval '1 hour','CARD_DECLINED') RETURNING id`,
      [`spec-${randomUUID()}`, payer.id, randomUUID()],
    );
    await withTx(t.pool, async (tx) => {
      const ctx = t.ctx();
      await recordTransition(tx, ctx, { aggregateType: 'payment', aggregateId: p.id, from: null, to: 'CREATED', reason: 'PREPARE' });
      await recordTransition(tx, ctx, { aggregateType: 'payment', aggregateId: p.id, from: 'CREATED', to: 'CONFIRMING' });
      await recordTransition(tx, ctx, { aggregateType: 'payment', aggregateId: p.id, from: 'CONFIRMING', to: 'FAILED', actorType: 'PROVIDER' });
    });
    expect(await rows(`SELECT to_state, failure_code, provider, subject_type, amount_minor FROM payment_attempts WHERE payment_id = $1 ORDER BY id`, [p.id])).toEqual([
      { to_state: 'CREATED', failure_code: null, provider: 'MOCK', subject_type: 'ORDER', amount_minor: 1000 },
      { to_state: 'CONFIRMING', failure_code: null, provider: 'MOCK', subject_type: 'ORDER', amount_minor: 1000 },
      { to_state: 'FAILED', failure_code: 'CARD_DECLINED', provider: 'MOCK', subject_type: 'ORDER', amount_minor: 1000 },
    ]);

    const [acct] = await rows(`INSERT INTO payout_accounts(user_id, bank_code, account_last4, account_token, holder_name, status) VALUES ($1,'004','1234','tok_secret','Kim','VERIFIED') RETURNING id`, [host.id]);
    const [paid] = await rows(
      `INSERT INTO settlements(payee_id, payee_type, period_start, period_end, gross_minor, fee_minor, refund_minor, net_minor, currency, status, payout_account_id, paid_at, payout_ref)
       VALUES ($1,'HOST',$2,$3,10000,1000,0,9000,'KRW','PAID',$4,now(),'BANK-1') RETURNING id`,
      [host.id, day(-30), day(-1), acct.id],
    );
    await t.pool.query(
      `INSERT INTO settlements(payee_id, payee_type, period_start, period_end, gross_minor, fee_minor, refund_minor, net_minor, currency, status)
       VALUES ($1,'HOST',$2,$3,500,0,0,500,'KRW','DRAFT')`,
      [host.id, day(-60), day(-31)],
    );
    await withTx(t.pool, async (tx) => {
      const ctx = t.ctx();
      await recordTransition(tx, ctx, { aggregateType: 'settlement', aggregateId: paid.id, from: 'APPROVED', to: 'PAYOUT_PENDING' });
      await recordTransition(tx, ctx, { aggregateType: 'settlement', aggregateId: paid.id, from: 'PAYOUT_PENDING', to: 'PAID' });
    });
    const payouts = await rows(`SELECT * FROM payouts WHERE payee_id = $1`, [host.id]);
    expect(payouts).toHaveLength(1); // DRAFT settlement has no payout
    expect(payouts[0]).toMatchObject({ settlement_id: paid.id, status: 'SENT', settlement_status: 'PAID', amount_minor: 9000, bank_code: '004', account_last4: '1234', payout_ref: 'BANK-1', reconciled_at: null });
    expect(payouts[0].requested_at).toBeInstanceOf(Date);
    expect(Object.keys(payouts[0])).not.toContain('account_token');

    await t.pool.query(`INSERT INTO receipts(user_id, payment_id, receipt_type, amount_minor, currency) VALUES ($1,$2,'PAYMENT',1000,'KRW')`, [payer.id, p.id]);
    expect(await rows(`SELECT receipt_type, amount_minor FROM receipt_records WHERE payment_id = $1`, [p.id])).toEqual([{ receipt_type: 'PAYMENT', amount_minor: 1000 }]);
  });

  it('search_projection_offsets aggregates search_sync_state; charter_content is the jetpool-charter CMS page', async () => {
    const idx = `spec_compat_${randomUUID().slice(0, 8)}`;
    await t.pool.query(
      `INSERT INTO search_sync_state(index_name, document_id, source_version, synced_at, status) VALUES
         ($1,'d1', now() - interval '1 hour', now(), 'SYNCED'),
         ($1,'d2', now() - interval '10 minutes', NULL, 'PENDING'),
         ($1,'d3', now() - interval '5 minutes', NULL, 'FAILED'),
         ($1,'d4', now() - interval '2 hours', now(), 'DELETED')`,
      [idx],
    );
    const [o] = await rows(`SELECT * FROM search_projection_offsets WHERE index_name = $1`, [idx]);
    expect(o).toMatchObject({ document_count: 4, synced_count: 1, pending_count: 1, failed_count: 1, deleted_count: 1 });
    expect(Number(o.lag_seconds)).toBeGreaterThanOrEqual(590);
    expect(Number(o.lag_seconds)).toBeLessThan(900);
    expect(o.last_synced_at).toBeInstanceOf(Date);

    const [page] = await rows(`INSERT INTO cms_entries(entry_type, slug, locale, title, status) VALUES ('PAGE','jetpool-charter','en-US','Charter','DRAFT') RETURNING id`);
    await t.pool.query(`INSERT INTO cms_entries(entry_type, slug, title) VALUES ('PAGE','spec-other-page','Other'),('STORY','jetpool-charter','Story with same slug')`);
    const charter = await rows(`SELECT id, slug, status FROM charter_content WHERE locale = 'en-US'`);
    expect(charter).toEqual([{ id: page.id, slug: 'jetpool-charter', status: 'DRAFT' }]);
  });
});

// ------------------------------------------------------------------------------------------------- exchange
interface Member { user: TestUser; propertyId: string }

async function member(opts: { city?: string; verified?: boolean } = {}): Promise<Member> {
  const user = await createUser(t, { verified: opts.verified ?? true });
  const { rows: p } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, max_guests, city, status, exchange_enabled, published_at)
     VALUES ($1,$2,'APARTMENT',4,$3,'PUBLISHED',true, now()) RETURNING id`,
    [user.id, `Home of ${user.email}`, opts.city ?? 'Seoul'],
  );
  await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city) VALUES ($1,'123 Secret-ro',$2)`, [p[0].id, opts.city ?? 'Seoul']);
  await t.pool.query(`INSERT INTO house_rules(property_id, quiet_hours) VALUES ($1,'22:00-07:00')`, [p[0].id]);
  const r = await call(t, user, 'PUT', '/v1/exchange/profile', { homeDescription: 'A quiet, sunny family apartment.', preferredDestinations: ['Busan'] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { user, propertyId: p[0].id };
}

async function toConfirmed(a: Member, b: Member) {
  const req = await call(t, a.user, 'POST', '/v1/exchanges', {
    myPropertyId: a.propertyId, theirPropertyId: b.propertyId,
    datesA: { start: day(30), end: day(35) }, datesB: { start: day(40), end: day(45) }, guestsA: 2, guestsB: 2,
  });
  expect(req.status, JSON.stringify(req.body)).toBe(201);
  const id = req.body.item.id as string;
  expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 })).status).toBe(200);
  expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true })).status).toBe(200);
  expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true })).body.item.status).toBe('AGREEMENT_PENDING');
  const hash = (await call(t, a.user, 'GET', `/v1/exchanges/${id}/agreement`)).body.item.termsHash as string;
  expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).status).toBe(200);
  expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).body.item.status).toBe('CONFIRMED');
  return { id, hash };
}

describe('exchange compat views + dispute via TRUST-03 openDispute', () => {
  it('exchange_eligibility mirrors evaluateEligibility()', async () => {
    await enableFlags(t, 'exchange.enabled');
    const ok = await member();
    const unverified = await member({ verified: false });
    const sanctioned = await member();
    const staff = await createUser(t, { roles: ['ADMIN'] });
    await t.pool.query(`INSERT INTO sanctions(user_id, sanction_type, reason, issued_by) VALUES ($1,'LISTING_SUSPENSION','spec test',$2)`, [sanctioned.user.id, staff.id]);
    for (const m of [ok, unverified, sanctioned]) {
      const api = (await call(t, m.user, 'GET', '/v1/exchange/eligibility')).body.item;
      const [v] = await rows(`SELECT eligible, unmet, exchange_home_count FROM exchange_eligibility WHERE user_id = $1`, [m.user.id]);
      expect(v, m.user.email).toMatchObject({ eligible: api.eligible, unmet: api.unmet, exchange_home_count: 1 });
    }
    expect((await rows(`SELECT unmet FROM exchange_eligibility WHERE user_id = $1`, [unverified.user.id]))[0].unmet).toEqual(['IDENTITY_NOT_VERIFIED']);
    expect((await rows(`SELECT unmet FROM exchange_eligibility WHERE user_id = $1`, [sanctioned.user.id]))[0].unmet).toEqual(['ACTIVE_SANCTION']);
  });

  it('agreement_acceptances / exchange_state_history follow the lifecycle; dispute opens through openDispute', async () => {
    await enableFlags(t, 'exchange.enabled');
    const a = await member();
    const b = await member({ city: 'Busan' });
    const { id, hash } = await toConfirmed(a, b);

    const acc = await rows(`SELECT party, party_role, user_id, terms_hash, accepted_at FROM agreement_acceptances WHERE exchange_id = $1 ORDER BY party`, [id]);
    expect(acc.map((r) => [r.party, r.party_role, r.user_id, r.terms_hash])).toEqual([
      ['A', 'REQUESTER', a.user.id, hash],
      ['B', 'RESPONDER', b.user.id, hash],
    ]);
    expect(acc.every((r) => r.accepted_at instanceof Date)).toBe(true);

    const r = await call(t, a.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'home not as described', description: 'Photos did not match the home', severity: 'CRITICAL' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.item.status).toBe('DISPUTED');
    const disputeId = r.body.disputeId as string;

    const hist = await rows(`SELECT from_state, to_state, actor_id, metadata FROM exchange_state_history WHERE exchange_id = $1 ORDER BY id`, [id]);
    expect(hist[0]).toMatchObject({ from_state: null, to_state: 'REQUESTED' });
    expect(hist.map((h) => h.to_state)).toContain('CONFIRMED');
    expect(hist.at(-1)).toMatchObject({ from_state: 'CONFIRMED', to_state: 'DISPUTED', actor_id: a.user.id, metadata: { disputeId } });

    // the dispute record is owned by TRUST-03: party-resolved counterparty, severity policy, timeline, evidence, FSM row
    const [d] = await rows(`SELECT * FROM disputes WHERE id = $1`, [disputeId]);
    expect(d).toMatchObject({ context_type: 'EXCHANGE', context_id: id, opened_by: a.user.id, counterparty_id: b.user.id, severity: 'HIGH', status: 'OPEN' });
    expect((await rows(`SELECT event_type FROM dispute_events WHERE dispute_id = $1`, [disputeId])).map((x) => x.event_type)).toEqual(['OPENED']);
    expect(await rows(`SELECT evidence_type, content FROM dispute_evidence WHERE dispute_id = $1`, [disputeId])).toEqual([{ evidence_type: 'TEXT', content: 'Photos did not match the home' }]);
    expect(await rows(`SELECT from_state, to_state FROM state_transitions WHERE aggregate_type = 'dispute' AND aggregate_id = $1`, [disputeId])).toEqual([{ from_state: null, to_state: 'OPEN' }]);
    const events = await rows(
      `SELECT event_type, payload FROM outbox_events WHERE (aggregate_type = 'dispute' AND aggregate_id = $1) OR (event_type = 'exchange.disputed' AND aggregate_id = $2) ORDER BY created_at`,
      [disputeId, id],
    );
    expect(events.filter((e) => e.event_type === 'dispute.opened')).toHaveLength(1);
    expect(events.find((e) => e.event_type === 'dispute.opened')!.payload).toMatchObject({ contextType: 'EXCHANGE', contextId: id, openedBy: a.user.id, counterpartyId: b.user.id });
    expect(events.filter((e) => e.event_type === 'exchange.disputed')).toHaveLength(1);
    expect((await rows(`SELECT 1 FROM audit_logs WHERE action = 'dispute.opened' AND resource_id = $1`, [disputeId])).length).toBe(1);

    // the dispute is visible to the counterparty through the TRUST-03 API
    expect((await call(t, b.user, 'GET', `/v1/disputes/${disputeId}`)).status).toBe(200);
    // DISPUTED is terminal for the exchange FSM
    expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'me too please' })).status).toBe(409);
  });

  it('a dispute already opened via /v1/disputes is linked (not duplicated) when the exchange is disputed', async () => {
    await enableFlags(t, 'exchange.enabled');
    const a = await member();
    const b = await member({ city: 'Busan' });
    const { id } = await toConfirmed(a, b);
    const pre = await call(t, b.user, 'POST', '/v1/disputes', { contextType: 'EXCHANGE', contextId: id, reason: 'keys were missing' });
    expect(pre.status, JSON.stringify(pre.body)).toBe(201);
    expect((await call(t, b.user, 'GET', `/v1/exchanges/${id}`)).body.item.status).toBe('CONFIRMED'); // generic route leaves the exchange alone

    const r = await call(t, b.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'keys were missing' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ disputeId: pre.body.item.id, item: { status: 'DISPUTED' } });
    expect(await rows(`SELECT id FROM disputes WHERE context_type = 'EXCHANGE' AND context_id = $1`, [id])).toEqual([{ id: pre.body.item.id }]);
    expect((await rows(`SELECT metadata FROM exchange_state_history WHERE exchange_id = $1 AND to_state = 'DISPUTED'`, [id]))[0].metadata).toEqual({ disputeId: pre.body.item.id });
  });
});
