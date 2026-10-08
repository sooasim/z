#!/usr/bin/env node
// DEV/STAGING seed: wires the legacy WONT Travel Club media migrated by @jetpool/legacy-import
// (packages/legacy-import/out/manifest.json + files under apps/web/public/legacy/) into the platform:
//  - media_assets (purpose CMS, visibility PUBLIC, public_url /legacy/..., storage_key legacy/wont/<sha256>.<ext>)
//    + migration_id_map rows (media, media_url) so `migrate-legacy reconcile --source WONT` can verify references
//  - one cms_entries row per legacy page (DRAFT for editorial review unless --publish), body_md with /legacy/ images,
//    seo from meta/og, hero_media_id, cms_external_refs (LEGACY_WONT, external_url), migration_id_map (content)
//  - seo_redirects legacy path → new path with approved=false (business sign-off happens in the admin UI)
//  - demo listings whose legacy context matches: Local Life/한달살기 photos → exchange homes (property_media),
//    tour photos → WONT demo travel products (media_ids), guide photos → demo guides without an avatar,
//    charter/about_jetpool → the jetpool-charter PAGE (hero/cover), city photos → destination covers.
// Deterministic ids, idempotent (a re-run with the same manifest changes nothing), one transaction, never deletes or
// overwrites edited data: legacy CMS rows are refreshed only while their body is unchanged since the last seed, and
// curated entries only get a cover when theirs is a generated placeholder (/art/…, /placeholder/…).
// Without a manifest it exits 0 and does nothing. Refuses NODE_ENV=production.
//
//   node packages/db/seed-legacy.mjs [--manifest <file>] [--public-dir apps/web/public] [--publish] [--dry-run] [--rollback]
import pg from 'pg';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImportPlan, LEGACY_SOURCE, LEGACY_SYSTEM } from '../legacy-import/src/plan.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-legacy refuses to run with NODE_ENV=production — use apps/api/scripts/migrate-legacy.ts with the CSVs in packages/legacy-import/out/import/');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const base = process.env.INIT_CWD || process.cwd();
const resolveP = (p) => (path.isAbsolute(p) ? p : path.resolve(base, p));
const MANIFEST = resolveP(arg('manifest', process.env.LEGACY_MANIFEST ?? path.join(HERE, '../legacy-import/out/manifest.json')));
const PUBLIC_DIR = resolveP(arg('public-dir', process.env.LEGACY_PUBLIC_DIR ?? path.join(HERE, '../../apps/web/public')));
const PUBLISH = flag('publish') || process.env.LEGACY_PUBLISH === '1';
const DRY = flag('dry-run');
const ROLLBACK = flag('rollback');
const MAX_PER_LISTING = 4;

const uid = (name) => {
  const h = createHash('sha256').update(`jetpool-seed:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const J = (v) => JSON.stringify(v);
const isPlaceholder = (u) => !u || /^\/(art|placeholder)\//.test(String(u));
const counts = {};
const bump = (k, n = 1) => n && (counts[k] = (counts[k] ?? 0) + n);
const log = (m) => console.log(`[seed-legacy] ${m}`);

if (!existsSync(MANIFEST)) {
  log(`no legacy manifest at ${MANIFEST} — nothing to seed (run: pnpm --filter @jetpool/legacy-import run migrate)`);
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const plan = buildImportPlan(manifest);
const fileExists = (publicPath) => !publicPath || flag('skip-file-check') || existsSync(path.join(PUBLIC_DIR, ...publicPath.split('/').filter(Boolean)));
const missing = plan.media.filter((m) => !fileExists(m.publicUrl));
if (missing.length) log(`WARNING: ${missing.length} media file(s) missing under ${PUBLIC_DIR} (skipped): ${missing.slice(0, 3).map((m) => m.publicUrl).join(', ')}`);
const media = plan.media.filter((m) => fileExists(m.publicUrl));
log(`manifest ${path.relative(base, MANIFEST)}: ${plan.entries.length} page(s), ${media.length} media, ${plan.redirects.length} redirect candidate(s)`);
if (DRY) {
  log(`dry run — assignments: ${Object.entries(plan.assignments).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  process.exit(0);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool' });
await db.connect();
const q = (text, params = []) => db.query(text, params);
const one = async (text, params = []) => (await db.query(text, params)).rows[0] ?? null;

const mediaRowId = (m) => uid(`legacy-media:${m.sha256}`);
const entryRowId = (e) => uid(`legacy-cms:${e.externalId}`);

async function rollback() {
  const ids = media.map(mediaRowId);
  const entryIds = plan.entries.map(entryRowId);
  bump('property_media removed', (await q(`DELETE FROM property_media WHERE media_id = ANY($1::uuid[])`, [ids])).rowCount);
  bump('travel_products cleaned', (await q(`UPDATE travel_products SET media_ids = ARRAY(SELECT x FROM unnest(media_ids) x WHERE NOT (x = ANY($1::uuid[]))) WHERE media_ids && $1::uuid[]`, [ids])).rowCount);
  bump('avatars cleared', (await q(`UPDATE user_profiles SET avatar_media_id = NULL WHERE avatar_media_id = ANY($1::uuid[])`, [ids])).rowCount);
  const curated = await q(`SELECT id, data, seo FROM cms_entries WHERE data ? 'legacyCover' OR data ? 'legacyGallery'`);
  for (const r of curated.rows) {
    const data = { ...r.data };
    if (data.legacyCover) {
      if (data.legacyCover.previous) data.coverUrl = data.legacyCover.previous;
      else delete data.coverUrl;
    }
    const seo = { ...r.seo };
    if (data.legacyCover && 'previousOgImage' in data.legacyCover) seo.og = { ...(seo.og ?? {}), image: data.legacyCover.previousOgImage ?? undefined };
    delete data.legacyCover;
    delete data.legacyGallery;
    await q(`UPDATE cms_entries SET data = $2, seo = $3, hero_media_id = CASE WHEN hero_media_id = ANY($4::uuid[]) THEN NULL ELSE hero_media_id END WHERE id = $1`, [r.id, J(data), J(seo), ids]);
    bump('curated entries restored');
  }
  await q(`UPDATE cms_entries SET hero_media_id = NULL WHERE hero_media_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))`, [ids, entryIds]);
  // legacy entries: only drafts the seed created and nobody edited are removed
  const del = await q(
    `SELECT id FROM cms_entries WHERE id = ANY($1::uuid[]) AND status = 'DRAFT' AND data->'legacy'->>'system' = $2
        AND encode(sha256(convert_to(coalesce(body_md, ''), 'UTF8')), 'hex') = data->'legacy'->>'bodySha256'`,
    [entryIds, LEGACY_SYSTEM],
  );
  const delIds = del.rows.map((r) => r.id);
  await q(`DELETE FROM cms_external_refs WHERE entry_id = ANY($1::uuid[])`, [delIds]);
  await q(`DELETE FROM migration_id_map WHERE legacy_type = 'content' AND new_id = ANY($1::uuid[])`, [delIds]);
  bump('cms_entries removed', (await q(`DELETE FROM cms_entries WHERE id = ANY($1::uuid[])`, [delIds])).rowCount);
  bump('seo_redirects removed', (await q(`DELETE FROM seo_redirects WHERE source = $1 AND approved = false AND legacy_path = ANY($2::text[])`, [LEGACY_SYSTEM, plan.redirects.map((r) => r.legacyPath)])).rowCount);
  await q(`DELETE FROM migration_id_map WHERE legacy_type IN ('media', 'media_url') AND new_id = ANY($1::uuid[])`, [ids]);
  bump(
    'media_assets removed',
    (await q(`DELETE FROM media_assets m WHERE m.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM cms_entries e WHERE e.hero_media_id = m.id) AND NOT EXISTS (SELECT 1 FROM property_media pm WHERE pm.media_id = m.id)`, [ids])).rowCount,
  );
}

async function seed() {
  // ---- migration batches (deterministic per manifest; a re-run with the same manifest adds none)
  const batch = {};
  for (const entity of ['media', 'content', 'redirects']) {
    batch[entity] = uid(`legacy-batch:${plan.manifestSha256}:${entity}`);
    await q(
      `INSERT INTO migration_batches(id, source, entity_type, mode, status, source_file_hash, source_count, report, finished_at)
       VALUES ($1,$2,$3,'APPLY','SUCCEEDED',$4,$5,$6, now()) ON CONFLICT (id) DO NOTHING`,
      [batch[entity], LEGACY_SOURCE, entity, plan.manifestSha256, entity === 'media' ? media.length : entity === 'content' ? plan.entries.length : plan.redirects.length, J({ seed: 'seed-legacy', manifest: path.basename(MANIFEST) })],
    );
  }
  const mapId = (type, legacyId, newId, b) =>
    q(`INSERT INTO migration_id_map(legacy_type, legacy_id, new_id, batch_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [type, legacyId, newId, b]);

  // ---- media assets
  const mediaId = new Map();
  for (const m of media) {
    const existing = await one(`SELECT id, public_url FROM media_assets WHERE storage_key = $1`, [m.storageKey]);
    let id = existing?.id;
    if (existing) {
      if (!existing.public_url) {
        await q(`UPDATE media_assets SET public_url = $2 WHERE id = $1 AND public_url IS NULL`, [id, m.publicUrl]);
        bump('media_assets (public_url filled)');
      }
    } else {
      id = mediaRowId(m);
      const r = await q(
        `INSERT INTO media_assets(id, storage_key, public_url, purpose, visibility, mime_type, byte_size, sha256, width, height, duration_ms, moderation_status, status, ready_at)
         VALUES ($1,$2,$3,'CMS','PUBLIC',$4,$5,$6,$7,$8,$9,'PENDING','READY', now()) ON CONFLICT (id) DO NOTHING`,
        [id, m.storageKey, m.publicUrl, m.mime, Math.max(1, m.bytes ?? 1), m.sha256, m.width, m.height, m.durationMs],
      );
      bump('media_assets', r.rowCount);
    }
    mediaId.set(m.assetId, id);
    await mapId('media', `wont:${m.assetId}`, id, batch.media);
    for (const u of new Set([m.publicUrl, m.originalPath, ...m.sourceUrls].filter(Boolean))) await mapId('media_url', u, id, batch.media);
  }
  const byAsset = new Map(media.map((m) => [m.assetId, m]));

  // ---- CMS entries for every legacy page
  for (const e of plan.entries) {
    const heroId = e.heroAssetId ? mediaId.get(e.heroAssetId) ?? null : null;
    const data = { ...e.data, legacy: { ...e.data.legacy, bodySha256: sha256(e.bodyMd), seededBy: 'seed-legacy' } };
    const r = await one(
      `INSERT INTO cms_entries(id, entry_type, slug, locale, title, summary, body_md, hero_media_id, seo, data, status, published_at)
       VALUES ($1,$2,$3,'ko-KR',$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (entry_type, slug, locale) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, body_md = EXCLUDED.body_md,
              hero_media_id = EXCLUDED.hero_media_id, seo = EXCLUDED.seo, data = EXCLUDED.data
        WHERE cms_entries.data->'legacy'->>'system' = $12
          AND cms_entries.data->'legacy'->>'importHash' IS DISTINCT FROM EXCLUDED.data->'legacy'->>'importHash'
          AND encode(sha256(convert_to(coalesce(cms_entries.body_md, ''), 'UTF8')), 'hex') = cms_entries.data->'legacy'->>'bodySha256'
       RETURNING id, (xmax = 0) AS inserted`,
      [entryRowId(e), e.type, e.slug, e.title, e.summary, e.bodyMd, heroId, J(e.seo), J(data), PUBLISH ? 'PUBLISHED' : 'DRAFT', PUBLISH ? new Date().toISOString() : null, LEGACY_SYSTEM],
    );
    let id = r?.id;
    if (r) bump(r.inserted ? 'cms_entries' : 'cms_entries (refreshed)');
    else {
      const cur = await one(`SELECT id, data->'legacy'->>'system' AS system FROM cms_entries WHERE entry_type = $1 AND slug = $2 AND locale = 'ko-KR'`, [e.type, e.slug]);
      if (cur?.system !== LEGACY_SYSTEM) {
        log(`WARNING: ${e.type} slug "${e.slug}" is used by a non-legacy entry — skipped ${e.legacyUrl}`);
        bump('cms_entries (slug taken, skipped)');
        continue;
      }
      id = cur.id;
    }
    bump(
      'cms_external_refs',
      (await q(`INSERT INTO cms_external_refs(entry_id, system, external_id, external_url, source_updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
        id, LEGACY_SYSTEM, e.externalId.slice(0, 300), e.legacyUrl.slice(0, 2000), e.data.legacy.lastmod ?? e.data.legacy.fetchedAt ?? null,
      ])).rowCount,
    );
    await mapId('content', e.externalId, id, batch.content);
  }

  // ---- 301 candidates (never overwrite an existing mapping; approval stays a business decision)
  for (const r of plan.redirects) {
    bump('seo_redirects', (await q(`INSERT INTO seo_redirects(legacy_path, target_path, status_code, approved, source) VALUES ($1,$2,$3,false,$4) ON CONFLICT (legacy_path) DO NOTHING`, [r.legacyPath, r.targetPath, r.statusCode, LEGACY_SYSTEM])).rowCount);
  }

  // ---- demo listings (seed-owned rows only), deterministic rotation so neighbours get different photos
  const pick = (assetIds, i, city, n = MAX_PER_LISTING) => {
    const list = assetIds.filter((a) => mediaId.has(a));
    if (!list.length) return [];
    const rot = (arr) => (arr.length ? [...arr.slice(i % arr.length), ...arr.slice(0, i % arr.length)] : []);
    const local = rot(list.filter((a) => city && byAsset.get(a).cities.includes(city)));
    const rest = rot(list.filter((a) => !local.includes(a)));
    return [...local, ...rest].slice(0, Math.min(n, list.length));
  };

  const homes = (await q(
    `SELECT p.id, p.slug, p.city FROM properties p
      WHERE p.exchange_enabled AND EXISTS (SELECT 1 FROM property_media pm JOIN media_assets m ON m.id = pm.media_id WHERE pm.property_id = p.id AND m.storage_key LIKE 'seed/%')
      ORDER BY p.slug`,
  )).rows;
  for (const [i, p] of homes.entries()) {
    for (const [k, a] of pick(plan.assignments.exchange, i, p.city).entries()) {
      const m = byAsset.get(a);
      bump('property_media (legacy)', (await q(`INSERT INTO property_media(property_id, media_id, sort_order, caption) VALUES ($1,$2,$3,$4) ON CONFLICT (property_id, media_id) DO NOTHING`, [p.id, mediaId.get(a), -100 + k, (m.caption ?? m.alt ?? 'WONT Travel Club 맞교환 사진').slice(0, 200)])).rowCount);
    }
  }

  const products = (await q(`SELECT id, slug, city, media_ids FROM travel_products WHERE supplier_id = $1 ORDER BY slug`, [uid('supplier:wont')])).rows;
  for (const [i, p] of products.entries()) {
    const want = pick(plan.assignments.tour, i, p.city).map((a) => mediaId.get(a));
    const add = want.filter((id) => !(p.media_ids ?? []).includes(id));
    if (add.length) {
      await q(`UPDATE travel_products SET media_ids = media_ids || $2::uuid[] WHERE id = $1`, [p.id, add]);
      bump('travel_products (legacy media)');
    }
  }

  const guides = (await q(
    `SELECT g.user_id, g.city FROM guide_profiles g JOIN users u ON u.id = g.user_id JOIN user_profiles up ON up.user_id = g.user_id
      WHERE u.email LIKE '%@jetpool.dev' AND up.avatar_media_id IS NULL ORDER BY u.email`,
  )).rows;
  for (const [i, g] of guides.entries()) {
    const [a] = pick(plan.assignments.guide, i, g.city, 1);
    if (a) bump('guide avatars (legacy)', (await q(`UPDATE user_profiles SET avatar_media_id = $2 WHERE user_id = $1 AND avatar_media_id IS NULL`, [g.user_id, mediaId.get(a)])).rowCount);
  }

  // curated CMS entries: real legacy photos replace generated placeholder covers (previous value kept for rollback)
  const CITY_SLUG = { jeju: 'Jeju', seoul: 'Seoul', busan: 'Busan', gangneung: 'Gangneung', sokcho: 'Sokcho', gyeongju: 'Gyeongju', jeonju: 'Jeonju', yeosu: 'Yeosu' };
  const curated = [
    { type: 'PAGE', slug: 'jetpool-charter', pool: plan.assignments.charter, gallery: true },
    { type: 'STORY', slug: 'jetpool-charter-story', pool: plan.assignments.charter, i: 1 },
    { type: 'STORY', slug: 'local-life-exchange', pool: plan.assignments.exchange },
    { type: 'STORY', slug: 'seoul-busan-month-swap', pool: plan.assignments.exchange, i: 1 },
    ...Object.entries(CITY_SLUG).map(([slug, city]) => ({ type: 'DESTINATION', slug, pool: media.filter((m) => m.eligible && m.cities.includes(city)).map((m) => m.assetId), city })),
  ];
  for (const c of curated) {
    const row = await one(`SELECT id, data, seo, hero_media_id FROM cms_entries WHERE entry_type = $1 AND slug = $2 AND locale = 'ko-KR'`, [c.type, c.slug]);
    const [first] = pick(c.pool, c.i ?? 0, c.city, 1);
    if (!row || !first) continue;
    const m = byAsset.get(first);
    const data = { ...row.data };
    let seo = row.seo ?? {};
    let coverSet = false;
    if (isPlaceholder(data.coverUrl) && !data.legacyCover) {
      data.legacyCover = { previous: data.coverUrl ?? null, previousOgImage: seo.og?.image ?? null, assetId: first };
      data.coverUrl = m.publicUrl;
      if (isPlaceholder(seo.og?.image)) seo = { ...seo, og: { ...(seo.og ?? {}), image: m.publicUrl } };
      coverSet = true;
    }
    if (c.gallery) {
      const items = c.pool.filter((a) => mediaId.has(a)).map((a) => ({ assetId: a, url: byAsset.get(a).publicUrl, srcset: byAsset.get(a).srcset, alt: byAsset.get(a).alt, caption: byAsset.get(a).caption, width: byAsset.get(a).width, height: byAsset.get(a).height, placeholder: byAsset.get(a).placeholder }));
      const g = { source: LEGACY_SYSTEM, importHash: sha256(J(items)), items };
      if (data.legacyGallery?.importHash !== g.importHash) data.legacyGallery = g;
    }
    if (J(data) === J(row.data) && J(seo) === J(row.seo ?? {})) continue;
    const r = await q(
      `UPDATE cms_entries SET data = $2, seo = $3, hero_media_id = CASE WHEN $7::boolean THEN coalesce(hero_media_id, $4) ELSE hero_media_id END
        WHERE id = $1 AND data = $5::jsonb AND seo = $6::jsonb`,
      [row.id, J(data), J(seo), mediaId.get(first), J(row.data), J(row.seo ?? {}), coverSet],
    );
    bump(`curated ${c.type} (legacy cover/gallery)`, r.rowCount);
  }
}

try {
  await q('BEGIN');
  if (ROLLBACK) await rollback();
  else await seed();
  await q('COMMIT');
} catch (err) {
  await q('ROLLBACK').catch(() => {});
  console.error(`[seed-legacy] failed, nothing written: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
log(`${ROLLBACK ? 'rollback' : 'seed'} ${process.exitCode ? 'aborted' : 'done'}${PUBLISH && !ROLLBACK ? ' (entries inserted as PUBLISHED)' : ''} — ${summary || 'no changes (already up to date)'}`);
