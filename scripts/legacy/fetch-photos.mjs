#!/usr/bin/env node
/**
 * Fetch openly-licensed REAL photos for the platform's listings, guides, tours and city cards from
 * Openverse (https://openverse.org — Wikimedia Commons, Flickr Creative Commons, ...).
 * Only licenses permitting commercial use are requested; full attribution is recorded per photo.
 *
 *   node scripts/legacy/fetch-photos.mjs --out photos-raw [--queries scripts/legacy/photo-queries.json]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = path.resolve(opt('out', 'photos-raw'));
const cfg = JSON.parse(await readFile(opt('queries', 'scripts/legacy/photo-queries.json'), 'utf8'));
const UA = 'JETPOOL-Platform/1.0 (photo sourcing; contact: repo owner)';
const MAX_BYTES = 25 * 1024 * 1024;
await mkdir(path.join(OUT, 'files'), { recursive: true });

const manifest = { generatedAt: new Date().toISOString(), source: 'openverse', photos: {}, queries: {}, failures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(q, page = 1) {
  const u = new URL('https://api.openverse.org/v1/images/');
  u.searchParams.set('q', q);
  u.searchParams.set('license_type', 'commercial');
  u.searchParams.set('page_size', String(Math.min(20, cfg.perQuery + 8)));
  u.searchParams.set('page', String(page));
  u.searchParams.set('mature', 'false');
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`openverse ${r.status}`);
    return r.json();
  }
  throw new Error('openverse rate limited');
}

for (const [group, queries] of Object.entries(cfg.groups)) {
  for (const q of queries) {
    const picked = [];
    try {
      const data = await api(q);
      for (const it of data.results ?? []) {
        if (picked.length >= cfg.perQuery) break;
        if (!it.url || (it.width && it.width < 1000)) continue;
        try {
          const r = await fetch(it.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
          const ct = (r.headers.get('content-type') || '').split(';')[0];
          if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(ct)) { manifest.failures.push({ q, url: it.url, reason: `HTTP ${r.status} ${ct}` }); continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > MAX_BYTES || buf.length < 20000) { manifest.failures.push({ q, url: it.url, reason: `size ${buf.length}` }); continue; }
          const sha = createHash('sha256').update(buf).digest('hex');
          const ext = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : 'jpg';
          if (!manifest.photos[sha]) {
            await writeFile(path.join(OUT, 'files', `${sha}.${ext}`), buf);
            manifest.photos[sha] = {
              sha256: sha, file: `files/${sha}.${ext}`, bytes: buf.length, width: it.width, height: it.height,
              title: it.title, creator: it.creator, creatorUrl: it.creator_url, license: it.license, licenseVersion: it.license_version,
              licenseUrl: it.license_url, landingUrl: it.foreign_landing_url, provider: it.provider, source: it.source,
              attribution: it.attribution, openverseId: it.id, groups: [], queries: [],
            };
          }
          const p = manifest.photos[sha];
          if (!p.groups.includes(group)) p.groups.push(group);
          if (!p.queries.includes(q)) p.queries.push(q);
          picked.push(sha);
        } catch (e) {
          manifest.failures.push({ q, url: it.url, reason: String(e?.message || e).slice(0, 160) });
        }
      }
    } catch (e) {
      manifest.failures.push({ q, reason: String(e?.message || e) });
    }
    manifest.queries[q] = { group, photos: picked };
    console.log(`${group} | ${q}: ${picked.length}`);
    await sleep(3500);
  }
}
manifest.summary = { photos: Object.keys(manifest.photos).length, queries: Object.keys(manifest.queries).length, failures: manifest.failures.length, bytes: Object.values(manifest.photos).reduce((s, p) => s + p.bytes, 0) };
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.summary));
