import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startFixture } from './fixture-server.mjs';
import { runFixture, tempDir } from './helpers.mjs';

/**
 * packages/db/seed-legacy.mjs against a scratch database: createdb → migrate.mjs → seed-dev.mjs → seed-legacy.mjs
 * with the manifest produced from the fixture site. Skipped when PostgreSQL is not reachable.
 */

const DB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const ADMIN_URL = process.env.LEGACY_TEST_ADMIN_URL ?? (process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool').replace(/\/[^/]*$/, '/postgres');
const DB_NAME = `jetpool_legacy_seed_${process.pid}_${Date.now()}`;
const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);

let available = true;
try {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await c.connect();
  await c.end();
} catch {
  available = false;
}
const skip = available ? false : 'PostgreSQL not reachable (set LEGACY_TEST_ADMIN_URL)';

let f;
let dir;
let cfg;
let db;
let baseline;

const node = (script, args = []) => {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`${path.basename(script)} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
};
const seedLegacy = (args = []) => node(path.join(DB_DIR, 'seed-legacy.mjs'), ['--manifest', path.join(cfg.outDir, 'manifest.json'), '--public-dir', path.dirname(cfg.publicDir), ...args]);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const scalar = async (sql, params = []) => Object.values((await rows(sql, params))[0])[0];

/** counts of pre-existing (non-legacy) demo data — seed-legacy must never delete or rewrite them */
async function demoCounts() {
  return rows(`SELECT
      (SELECT count(*) FROM properties)::int AS properties,
      (SELECT count(*) FROM property_media pm JOIN media_assets m ON m.id = pm.media_id WHERE m.storage_key NOT LIKE 'legacy/%')::int AS seed_property_media,
      (SELECT count(*) FROM media_assets WHERE storage_key NOT LIKE 'legacy/%')::int AS seed_media,
      (SELECT count(*) FROM cms_entries WHERE slug NOT LIKE 'legacy-%')::int AS cms,
      (SELECT md5(string_agg(legacy_path || target_path || approved::text, ',' ORDER BY legacy_path)) FROM seo_redirects WHERE coalesce(source, '') <> 'LEGACY_WONT' OR approved) AS redirects,
      (SELECT count(*) FROM travel_products)::int AS products,
      (SELECT count(*) FROM users)::int AS users`).then((r) => r[0]);
}

before(async () => {
  if (skip) return;
  f = await startFixture();
  dir = await tempDir();
  ({ cfg } = await runFixture(f, dir, 'all', { allowPartial: true }));
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  node(path.join(DB_DIR, 'migrate.mjs'));
  node(path.join(DB_DIR, 'seed-dev.mjs'));
  db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  baseline = await demoCounts();
});

after(async () => {
  await db?.end().catch(() => {});
  if (available && cfg) {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  await f?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('seed-legacy wires media, CMS drafts, external refs, unapproved 301s and demo listings', { skip }, async () => {
  const out = seedLegacy();
  assert.match(out, /seed done/);
  const plan = JSON.parse(await readFile(path.join(cfg.outDir, 'import', 'plan.json'), 'utf8'));

  const media = await rows(`SELECT * FROM media_assets WHERE storage_key LIKE 'legacy/wont/%'`);
  assert.equal(media.length, plan.media.length);
  for (const m of media) {
    assert.equal(m.purpose, 'CMS');
    assert.equal(m.visibility, 'PUBLIC');
    assert.equal(m.status, 'READY');
    assert.match(m.public_url, /^\/legacy\/[0-9a-f]{12}\//);
    assert.ok(existsSync(path.join(path.dirname(cfg.publicDir), m.public_url)), `public file for ${m.public_url}`);
  }

  const entries = await rows(`SELECT * FROM cms_entries WHERE data->'legacy'->>'system' = 'LEGACY_WONT' AND slug LIKE 'legacy-%' ORDER BY slug`);
  assert.deepEqual(entries.map((e) => e.slug), ['legacy-about-jetpool', 'legacy-blogpost-heart-letter-01', 'legacy-board-story-1', 'legacy-index', 'legacy-local-guide', 'legacy-locallife', 'legacy-product-past-trip', 'legacy-tour-ticket', 'legacy-tour-ticket-idx-1']);
  assert.ok(entries.every((e) => e.status === 'DRAFT'), 'imported pages wait for editorial review');
  const about = entries.find((e) => e.slug === 'legacy-about-jetpool');
  assert.equal(about.entry_type, 'PAGE');
  assert.ok(about.hero_media_id);
  assert.match(about.body_md, /!\[전세기 앞에서 단체 사진\]\(\/legacy\//);
  assert.match(about.seo.og.image, /^\/legacy\//);
  const story = entries.find((e) => e.slug === 'legacy-board-story-1');
  assert.equal(story.entry_type, 'STORY');

  const refs = await rows(`SELECT r.*, e.slug FROM cms_external_refs r JOIN cms_entries e ON e.id = r.entry_id WHERE r.system = 'LEGACY_WONT' AND e.slug LIKE 'legacy-%'`);
  assert.equal(refs.length, 9);
  assert.equal(refs.find((r) => r.slug === 'legacy-about-jetpool').external_url, `${f.site}/about_jetpool`);

  const red = Object.fromEntries((await rows(`SELECT * FROM seo_redirects`)).map((r) => [r.legacy_path, r]));
  assert.equal(red['/about_jetpool'].target_path, '/jetpool-charter');
  assert.equal(red['/about_jetpool'].approved, false);
  assert.equal(red['/about_jetpool'].source, 'LEGACY_WONT');
  assert.equal(red['/old-about'].approved, false);
  assert.equal(red['/localLife'].approved, true, 'an existing approved mapping is left alone');

  // every media reference in legacy content resolves (same check as migrate-legacy reconcile)
  const broken = await rows(
    `SELECT DISTINCT r.url FROM cms_entries e, jsonb_array_elements_text(coalesce(e.data->'legacy'->'media', '[]'::jsonb)) AS r(url)
      WHERE e.data->'legacy'->>'source' = 'WONT'
        AND NOT EXISTS (SELECT 1 FROM migration_id_map m WHERE m.legacy_type = 'media_url' AND m.legacy_id = r.url)`,
  );
  assert.deepEqual(broken, []);

  // demo listings: exchange homes now open with a real legacy photo (cover = lowest sort_order)
  const covers = await rows(
    `SELECT p.slug, (SELECT m.public_url FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
                      WHERE pm.property_id = p.id AND m.visibility = 'PUBLIC' AND m.status = 'READY' ORDER BY pm.sort_order LIMIT 1) AS cover
       FROM properties p WHERE p.exchange_enabled ORDER BY p.slug`,
  );
  assert.ok(covers.length > 0 && covers.every((c) => c.cover.startsWith('/legacy/')), JSON.stringify(covers));
  const exchangeIds = new Set(plan.assignments.exchange);
  const used = await rows(`SELECT DISTINCT m.public_url FROM property_media pm JOIN media_assets m ON m.id = pm.media_id WHERE m.storage_key LIKE 'legacy/%'`);
  const byUrl = new Map(plan.media.map((m) => [m.publicUrl, m.assetId]));
  assert.ok(used.every((u) => exchangeIds.has(byUrl.get(u.public_url))), 'only Local Life / 한달살기 photos go to exchange homes');
  const nonExchange = await scalar(`SELECT count(*)::int FROM property_media pm JOIN properties p ON p.id = pm.property_id JOIN media_assets m ON m.id = pm.media_id WHERE m.storage_key LIKE 'legacy/%' AND NOT p.exchange_enabled`);
  assert.equal(nonExchange, 0);

  const products = await rows(`SELECT slug, media_ids FROM travel_products WHERE cardinality(media_ids) > 0`);
  assert.ok(products.length > 0);
  const tourMediaIds = new Set((await rows(`SELECT id FROM media_assets WHERE public_url = ANY($1::text[])`, [plan.media.filter((m) => plan.assignments.tour.includes(m.assetId)).map((m) => m.publicUrl)])).map((r) => r.id));
  assert.ok(products.every((p) => p.media_ids.every((id) => tourMediaIds.has(id))), 'tour pages → travel products');

  const charter = (await rows(`SELECT * FROM cms_entries WHERE entry_type = 'PAGE' AND slug = 'jetpool-charter'`))[0];
  assert.match(charter.data.coverUrl, /^\/legacy\//);
  assert.ok(charter.data.legacyGallery.items.length >= 3);
  assert.ok(charter.hero_media_id);
  assert.ok(Array.isArray(charter.data.sections), 'curated page content is kept');
  const jeju = (await rows(`SELECT data FROM cms_entries WHERE entry_type = 'DESTINATION' AND slug = 'jeju'`))[0];
  assert.equal(jeju.data.legacyCover.previous, '/art/postcards/jeju.svg', 'placeholder art replaced, previous value kept for rollback');

  assert.deepEqual(await demoCounts(), baseline, 'no existing demo data deleted or rewritten');
});

test('re-running seed-legacy is a no-op (deterministic ids, idempotent inserts)', { skip }, async () => {
  const snap = async () =>
    rows(`SELECT
      (SELECT md5(string_agg(id::text || coalesce(public_url, ''), ',' ORDER BY id)) FROM media_assets) AS media,
      (SELECT md5(string_agg(id::text || title || coalesce(body_md, '') || data::text || seo::text || coalesce(hero_media_id::text, ''), ',' ORDER BY id)) FROM cms_entries) AS cms,
      (SELECT md5(string_agg(property_id::text || media_id::text || sort_order, ',' ORDER BY property_id, media_id)) FROM property_media) AS pm,
      (SELECT md5(string_agg(id::text || media_ids::text, ',' ORDER BY id)) FROM travel_products) AS tp,
      (SELECT count(*) FROM seo_redirects) AS red, (SELECT count(*) FROM migration_id_map) AS idmap,
      (SELECT count(*) FROM migration_batches) AS batches, (SELECT count(*) FROM cms_external_refs) AS refs`).then((r) => r[0]);
  const a = await snap();
  const out = seedLegacy();
  assert.match(out, /no changes \(already up to date\)/);
  assert.deepEqual(await snap(), a);
});

test('a newer manifest refreshes untouched legacy drafts but never overwrites an edited one', { skip }, async () => {
  const m = JSON.parse(await readFile(path.join(cfg.outDir, 'manifest.json'), 'utf8'));
  await db.query(`UPDATE cms_entries SET body_md = body_md || E'\\n\\n편집자가 추가한 문단' WHERE slug = 'legacy-board-story-1'`);
  for (const p of m.pages) if (p.title) p.title = p.title.replace('WONT Travel Club', 'WONT Travel Club (재수집)');
  m.pages.find((p) => p.url.endsWith('/local_guide')).headings = [{ level: 1, text: '로컬 가이드 프렌드 2' }];
  m.pages.find((p) => p.url.endsWith('/local_guide')).blocks.push({ type: 'text', text: '새로 수집된 문단' });
  m.contentSha256 = 'changed';
  const manifest2 = path.join(dir, 'manifest-2.json');
  await writeFile(manifest2, JSON.stringify(m));
  const r = spawnSync(process.execPath, [path.join(DB_DIR, 'seed-legacy.mjs'), '--manifest', manifest2, '--public-dir', path.dirname(cfg.publicDir)], { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cms_entries \(refreshed\)/);
  const guide = (await rows(`SELECT body_md FROM cms_entries WHERE slug = 'legacy-local-guide'`))[0];
  assert.match(guide.body_md, /새로 수집된 문단/);
  const story = (await rows(`SELECT body_md FROM cms_entries WHERE slug = 'legacy-board-story-1'`))[0];
  assert.match(story.body_md, /편집자가 추가한 문단/);
});

test('--rollback removes what the seed added and restores placeholder covers; edited drafts and other data stay', { skip }, async () => {
  const out = seedLegacy(['--rollback']);
  assert.match(out, /rollback done/);
  assert.equal(await scalar(`SELECT count(*)::int FROM property_media pm JOIN media_assets m ON m.id = pm.media_id WHERE m.storage_key LIKE 'legacy/%'`), 0);
  assert.equal(await scalar(`SELECT count(*)::int FROM travel_products WHERE cardinality(media_ids) > 0`), 0);
  const jeju = (await rows(`SELECT data FROM cms_entries WHERE entry_type = 'DESTINATION' AND slug = 'jeju'`))[0];
  assert.equal(jeju.data.coverUrl, '/art/postcards/jeju.svg');
  assert.ok(!('legacyCover' in jeju.data));
  const charter = (await rows(`SELECT data, hero_media_id FROM cms_entries WHERE entry_type = 'PAGE' AND slug = 'jetpool-charter'`))[0];
  assert.ok(!('coverUrl' in charter.data) && !('legacyGallery' in charter.data));
  assert.equal(charter.hero_media_id, null);
  const left = await rows(`SELECT slug FROM cms_entries WHERE slug LIKE 'legacy-%'`);
  assert.deepEqual(left.map((r) => r.slug), ['legacy-board-story-1'], 'the edited draft is kept for the editor');
  assert.equal(await scalar(`SELECT count(*)::int FROM seo_redirects WHERE source = 'LEGACY_WONT' AND NOT approved`), 0);
  const after = await demoCounts();
  assert.deepEqual({ ...after, cms: after.cms }, baseline);
});

test('without a manifest the seed is a no-op that exits 0', { skip }, () => {
  const r = spawnSync(process.execPath, [path.join(DB_DIR, 'seed-legacy.mjs'), '--manifest', path.join(dir, 'does-not-exist.json')], { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to seed/);
});
