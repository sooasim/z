#!/usr/bin/env node
/**
 * Profile photos for the demo people: openly-licensed REAL portraits from Openverse (Flickr CC, Wikimedia Commons),
 * square-cropped and published as avatar renditions for the seeded hosts, guides and travellers.
 *
 *   node scripts/legacy/fetch-people.mjs fetch   [--raw .legacy/people-raw] [--queries scripts/legacy/people-queries.json]
 *   node scripts/legacy/fetch-people.mjs publish [--raw .legacy/people-raw] [--public apps/web/public] [--check]
 *
 *   fetch   → <raw>/manifest.json + <raw>/files/<sha256>.<ext> (git-ignored working set) and prints every candidate
 *             with its licence so it can be reviewed by eye.
 *   review  → data/media/photo-curation-person.json: per sha256 `accepted` (+ `reason` when rejected), `subjectKo` /
 *             `subjectEn`, `roles`, `quality` and the `crop` that keeps the face in a square.
 *   publish → <public>/photos/<sha12>/{96,192,384}.webp + data/media/people.json (served facts + attribution),
 *             read by scripts/legacy/assign.mjs. `--check` verifies the published files and people.json are current.
 *
 * Rules
 * - Only CC BY / BY-SA / CC0 / PDM: commercial use AND derivatives (the square crop) must be allowed. Anything with
 *   "-nd" is refused at fetch and again at publish. The full attribution travels with every photo and is shown on
 *   /credits, exactly like the scene photos from scripts/legacy/fetch-photos.mjs.
 * - A published portrait is a STAND-IN for a demo persona — never a statement about the person shown. Only photos
 *   accepted in the curation file are published; the file keeps the reason for every rejection.
 * - Deterministic: the same raw files + the same curation produce byte-identical public files and people.json
 *   (no timestamps). Only <sha12> directories this script published before are pruned.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => argv.includes(`--${n}`);
const CHECK = flag('check'); // publish --check: verify the published files and people.json are current, write nothing

const RAW = path.resolve(ROOT, opt('raw', process.env.PEOPLE_RAW_DIR || '.legacy/people-raw'));
const PUB = path.resolve(ROOT, opt('public', 'apps/web/public'));
const QUERIES = path.resolve(ROOT, opt('queries', 'scripts/legacy/people-queries.json'));
const CURATION = path.join(ROOT, 'data/media/photo-curation-person.json');
const OUT = path.join(ROOT, 'data/media/people.json');
const PHOTOS_DIR = path.join(PUB, 'photos');

const UA = 'JETPOOL-Platform/1.0 (profile photo sourcing; contact: repo owner)';
const LICENSES = ['by', 'by-sa', 'cc0', 'pdm']; // commercial use + derivatives (the square crop)
const LADDER = [96, 192, 384]; // avatars render at 30–96 px (×2 / ×4 displays)
const WEBP = { quality: 82, effort: 5 };
const PLACEHOLDER = { width: 24, quality: 40 };
const MAX_BYTES = 25 * 1024 * 1024;
const MIN_BYTES = 10 * 1024;

const fail = (msg) => {
  console.error(`people: ${msg}`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const isND = (license) => /(^|-)nd($|-)/i.test(String(license ?? ''));
const licenseLabel = (code, version) =>
  code === 'cc0' ? `CC0 ${version || '1.0'}` : code === 'pdm' ? 'Public Domain Mark 1.0' : `CC ${String(code).toUpperCase()} ${version || ''}`.trim();
/** Read a file, or undefined when it is not there — one syscall, never "exists? then read" (TOCTOU). */
const readMaybe = async (p) => fs.readFile(p).catch((e) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
const readText = async (p) => (await readMaybe(p))?.toString('utf8');
const readJson = async (p) => {
  const t = await readText(p);
  return t === undefined ? undefined : JSON.parse(t);
};

// ───────────────────────────────────────────────────────────── fetch
async function fetchCandidates() {
  const cfg = readJson(QUERIES);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await fs.mkdir(path.join(RAW, 'files'), { recursive: true });
  const prev = await readJson(path.join(RAW, 'manifest.json'));
  const manifest = { fetchedAt: new Date().toISOString(), source: 'openverse', photos: { ...(prev?.photos ?? {}) }, queries: {}, failures: [] };

  async function api(q) {
    const u = new URL('https://api.openverse.org/v1/images/');
    u.searchParams.set('q', q);
    u.searchParams.set('license', LICENSES.join(','));
    u.searchParams.set('category', 'photograph');
    u.searchParams.set('mature', 'false');
    u.searchParams.set('page_size', String(Math.min(20, (cfg.perQuery ?? 6) + 10)));
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (r.status === 429) {
        await sleep(15000 * (attempt + 1));
        continue;
      }
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
          if (picked.length >= (cfg.perQuery ?? 6)) break;
          if (!it.url || isND(it.license)) continue;
          if (it.width && it.height && Math.min(it.width, it.height) < (cfg.minWidth ?? 600)) continue;
          try {
            const r = await fetch(it.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
            const ct = (r.headers.get('content-type') || '').split(';')[0];
            if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(ct)) {
              manifest.failures.push({ q, url: it.url, reason: `HTTP ${r.status} ${ct}` });
              continue;
            }
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > MAX_BYTES || buf.length < MIN_BYTES) {
              manifest.failures.push({ q, url: it.url, reason: `size ${buf.length}` });
              continue;
            }
            const sha = sha256(buf);
            const ext = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : 'jpg';
            if (!manifest.photos[sha]) {
              // The candidate is an image body fetched from the provider CDN, written to the git-ignored raw working
              // set under its own sha256 and never executed; `publish` only reads back bytes whose sha256 still matches.
              await fs.writeFile(path.join(RAW, 'files', `${sha}.${ext}`), buf); // lgtm[js/http-to-file-access] codeql[js/http-to-file-access]
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
  await fs.writeFile(path.join(RAW, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const n = Object.keys(manifest.photos).length;
  console.log(`\npeople: ${n} candidates in ${path.relative(ROOT, RAW)} (${manifest.failures.length} failures)`);
  console.log('review them by eye, then record the decisions in data/media/photo-curation-person.json');
  for (const [sha, p] of Object.entries(manifest.photos)) {
    console.log(`  ${sha.slice(0, 12)} ${String(p.width)}x${String(p.height)} ${licenseLabel(p.license, p.licenseVersion).padEnd(14)} ${p.groups.join(',').padEnd(6)} ${String(p.title ?? '').slice(0, 60)}`);
  }
}

// ───────────────────────────────────────────────────────────── publish
const CROP = {
  attention: { strategy: 'attention' }, entropy: { strategy: 'entropy' },
  center: { position: 'centre' }, top: { position: 'top' }, bottom: { position: 'bottom' }, left: { position: 'left' }, right: { position: 'right' },
};

async function publish() {
  const require = createRequire(path.join(ROOT, 'packages/legacy-import/package.json'));
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    fail('sharp is not installed — run: pnpm install --filter @jetpool/legacy-import');
  }
  sharp.cache(false);
  const manifest = await readJson(path.join(RAW, 'manifest.json'));
  if (!manifest) fail(`no raw candidates at ${path.relative(ROOT, RAW)} — run: node scripts/legacy/fetch-people.mjs fetch`);
  const curationRaw = await readText(CURATION);
  if (curationRaw === undefined) fail(`no curation at ${path.relative(ROOT, CURATION)} — review the candidates first`);
  const curation = JSON.parse(curationRaw);
  const decisions = curation.photos ?? curation;
  const previous = await readJson(OUT);

  const photos = {};
  const written = new Set();
  const stale = []; // --check: published files that no longer match the curation
  for (const [sha, d] of Object.entries(decisions)) {
    const m = manifest.photos[sha];
    if (!m) fail(`curation decides ${sha.slice(0, 12)} but the raw manifest has no such photo`);
    if (!d.accepted) continue;
    if (isND(m.license)) fail(`${sha.slice(0, 12)} is ND-licensed (${m.license}) — a square crop is a derivative`);
    if (!LICENSES.includes(m.license)) fail(`${sha.slice(0, 12)} has license ${m.license}, expected one of ${LICENSES.join('/')}`);
    if (!m.landingUrl || !m.licenseUrl || !m.attribution) fail(`${sha.slice(0, 12)} is missing attribution facts`);
    if (m.license !== 'cc0' && m.license !== 'pdm' && !m.creator) fail(`${sha.slice(0, 12)} needs a creator (${m.license})`);
    if (!d.subjectKo || !d.subjectEn) fail(`${sha.slice(0, 12)} is accepted without subjectKo/subjectEn`);
    const crop = CROP[d.crop ?? 'attention'];
    if (!crop) fail(`${sha.slice(0, 12)} has unknown crop "${d.crop}" (${Object.keys(CROP).join(', ')})`);

    const s12 = sha.slice(0, 12);
    const buf = await fs.readFile(path.join(RAW, m.file));
    if (sha256(buf) !== sha) fail(`${s12}: raw file no longer matches its sha256`);
    const base = sharp(buf, { failOn: 'error' }).rotate(); // EXIF orientation applied, metadata stripped
    const meta = await base.clone().metadata();
    const side = Math.min(meta.width ?? 0, meta.height ?? 0);
    if (!side) fail(`${s12}: cannot read the image dimensions`);
    const widths = LADDER.filter((w) => w <= side);
    if (!widths.length) fail(`${s12} is only ${side}px on its short side — too small for an avatar`);

    const dir = path.join(PHOTOS_DIR, s12);
    if (!CHECK) await fs.mkdir(dir, { recursive: true });
    const square = (w) =>
      base
        .clone()
        .resize({ width: w, height: w, fit: 'cover', withoutEnlargement: false, ...(crop.strategy ? { position: sharp.strategy[crop.strategy] } : { position: crop.position }) })
        .webp(WEBP);
    const variants = {};
    const outBytes = {};
    for (const w of widths) {
      const out = await square(w).toBuffer();
      const file = path.join(dir, `${w}.webp`);
      const current = await readMaybe(file);
      if (!current?.equals(out)) {
        if (CHECK) stale.push(`photos/${s12}/${w}.webp`);
        else await fs.writeFile(file, out);
      }
      variants[String(w)] = `/photos/${s12}/${w}.webp`;
      outBytes[String(w)] = out.length;
      written.add(`${s12}/${w}.webp`);
    }
    const src = variants[String(widths[widths.length - 1])];
    const main = widths[widths.length - 1];
    const ph = await square(PLACEHOLDER.width).webp({ quality: PLACEHOLDER.quality, effort: 4 }).toBuffer();
    const stats = await base.clone().stats();
    const [r, g, b] = stats.channels.map((c) => c.mean);

    photos[sha] = {
      collection: 'person',
      sha12: s12,
      kind: 'photo',
      format: meta.format,
      variants,
      src,
      srcset: widths.map((w) => `${variants[String(w)]} ${w}w`).join(', '),
      width: main,
      height: main,
      aspect: 1,
      placeholder: `data:image/webp;base64,${ph.toString('base64')}`,
      color: hex(stats.dominant),
      colorAvg: hex({ r, g, b }),
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      bytes: m.bytes,
      outputBytes: outBytes[String(main)],
      title: m.title ?? null,
      creator: m.creator ?? null,
      creatorUrl: m.creatorUrl ?? null,
      license: m.license,
      licenseVersion: m.licenseVersion ?? null,
      licenseLabel: licenseLabel(m.license, m.licenseVersion),
      licenseUrl: m.licenseUrl,
      landingUrl: m.landingUrl,
      provider: m.provider ?? m.source ?? null,
      source: m.source ?? null,
      openverseId: m.openverseId ?? null,
      attribution: m.attribution,
      groups: [...(m.groups ?? [])].sort(),
      queries: [...(m.queries ?? [])].sort(),
      accepted: true,
      roles: [...(d.roles ?? [])].sort(),
      subjectKo: d.subjectKo,
      subjectEn: d.subjectEn,
      quality: d.quality ?? 3,
      alt: d.subjectKo,
      crop: d.crop ?? 'attention',
      requiresAttribution: m.license !== 'cc0' && m.license !== 'pdm',
      shareAlike: m.license === 'by-sa',
      credit: {
        ko: `사진: ${m.creator ?? '작자 미상'} · ${licenseLabel(m.license, m.licenseVersion)}`,
        en: `${m.title ? `“${m.title}” ` : ''}by ${m.creator ?? 'unknown'} — ${licenseLabel(m.license, m.licenseVersion)}`,
        url: m.landingUrl,
        licenseUrl: m.licenseUrl,
      },
      curatedIn: 'photo-curation-person.json',
      shown: true,
    };
  }

  // prune renditions this script published before and no longer publishes
  const pruned = [];
  for (const [sha, p] of Object.entries(previous?.photos ?? {})) {
    if (photos[sha]) continue;
    const dir = path.join(PHOTOS_DIR, p.sha12);
    const there = await fs.stat(dir).then(() => true, () => false);
    if (!there) continue;
    pruned.push(dir);
    if (CHECK) stale.push(`photos/${p.sha12}/ (no longer curated)`);
    else await fs.rm(dir, { recursive: true, force: true });
  }

  const doc = {
    version: 1,
    readme:
      'Generated by scripts/legacy/fetch-people.mjs (publish) from data/media/photo-curation-person.json — do not edit by hand. ' +
      'Openly-licensed real portraits used as the demo profile photos of seeded hosts, guides and travellers; the person shown ' +
      'is not the demo persona. Read by scripts/legacy/assign.mjs, credited on /credits.',
    source: 'openverse',
    licenses: LICENSES,
    ladder: LADDER,
    curation: { file: 'data/media/photo-curation-person.json', sha256: sha256(curationRaw) },
    rejected: Object.entries(decisions)
      .filter(([, d]) => !d.accepted)
      .map(([sha, d]) => ({ sha12: sha.slice(0, 12), reason: d.reason ?? '' }))
      .sort((a, b) => a.sha12.localeCompare(b.sha12)),
    photos: Object.fromEntries(Object.entries(photos).sort((a, b) => a[0].localeCompare(b[0]))),
  };
  const out = `${JSON.stringify(doc, null, 2)}\n`;
  if (CHECK) {
    if ((await readText(OUT)) !== out) stale.unshift('data/media/people.json');
    if (stale.length) fail(`out of date: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? `, +${stale.length - 5} more` : ''} — run node scripts/legacy/fetch-people.mjs publish`);
    console.log(`people: people.json and the ${written.size} published renditions are current`);
    return;
  }
  await fs.writeFile(OUT, out);
  console.log(
    `people: published ${Object.keys(photos).length} portraits (${written.size} files${pruned.length ? `, pruned ${pruned.length}` : ''}) → ` +
      `${path.relative(ROOT, PHOTOS_DIR)}/<sha12>/{${LADDER.join(',')}}.webp and ${path.relative(ROOT, OUT)}`,
  );
}

switch (cmd) {
  case 'fetch':
    await fetchCandidates();
    break;
  case 'publish':
    await publish();
    break;
  default:
    console.log('usage: node scripts/legacy/fetch-people.mjs fetch|publish [--raw .legacy/people-raw] [--public apps/web/public] [--check]');
    process.exit(cmd === 'help' ? 0 : 2);
}
