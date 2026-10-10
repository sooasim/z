#!/usr/bin/env node
// Deterministic media assignment: data/media/catalog.json → data/media/assignments.json + apps/web/public/media-map.json
//
// Decides which real photo / migrated wontc.co.kr image appears where on the platform:
//  - every seeded stay (packages/db/seed-dev.mjs PROPERTIES) gets 5 photos: an exterior / neighbourhood photo that matches
//    its city and type (hanok → hanok lanes, villa → villa/pool, beach apartments → ocean view; never the same cover twice)
//    followed by 4 interiors (living, bedroom, kitchen, bathroom/balcony/pool) picked least-used-first
//  - guides get a cover photo matching their interests/city (scenes only — the portrait goes on the profile instead)
//  - every seeded person (host, guide, traveller) gets a profile photo: a real, openly-licensed portrait from
//    data/media/people.json that fits the persona's age and description. It is a STAND-IN, never a photo of that
//    person, and it is credited on /credits like every other licensed photo. Unassigned portraits stay in a pool the
//    web uses for people the seed does not know (review authors, demo staff)
//  - travel products get theme photos; the past WONT tour products become products with their legacy images
//  - CMS destinations get city photos, stories legacy images or city photos, the charter page charter photos + legacy
//    aircraft images, the home hero the best hero candidates + legacy brand heroes
//  - every migrated wontc.co.kr page becomes a CMS entry (PAGE / STORY / LEGACY_CONTENT) whose body is the migrated
//    Korean text with its images where they appeared (data/media/legacy-pages/*.md); a PAGE "brand-archive" lists all
//    273 legacy media. The script ASSERTS that every legacy medium is referenced (archive + a contextual placement),
//    that only accepted, non-ND photos are used and that every used photo carries its credit.
// Inputs are read-only. Output is byte-identical for identical inputs (no timestamps besides the catalog's own).
//
//   node scripts/legacy/assign.mjs [--check]     (--check: verify the outputs are current, exit 1 otherwise)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = process.argv.includes('--check');
const CATALOG = path.join(ROOT, 'data/media/catalog.json');
const PEOPLE = path.join(ROOT, 'data/media/people.json');
const OUT_ASSIGN = path.join(ROOT, 'data/media/assignments.json');
const OUT_MAP = path.join(ROOT, 'apps/web/public/media-map.json');
const PUBLIC = path.join(ROOT, 'apps/web/public');
const PAGES_DIR = path.join(ROOT, 'data/media/legacy-pages');
const SEED_DEV = path.join(ROOT, 'packages/db/seed-dev.mjs');

const fail = (msg) => {
  console.error(`assign: ${msg}`);
  process.exit(1);
};
const uid = (name) => {
  const h = createHash('sha256').update(`jetpool-seed:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// ───────────────────────────────────────────────────────────── inputs
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const peopleDoc = existsSync(PEOPLE) ? JSON.parse(readFileSync(PEOPLE, 'utf8')) : { photos: {} };
const LEG = catalog.legacy.assets; // sha256 → legacy asset
// sha256 → photo: the scene photos of the catalog plus the portraits of data/media/people.json (collection 'person'),
// which carry the same fields (src, srcset, placeholder, credit, roles…) and are credited the same way.
const PH = { ...catalog.photos, ...peopleDoc.photos };
const legacyBy12 = new Map(Object.entries(LEG).map(([sha, a]) => [a.sha12, { sha, ...a }]));
const photoBy12 = new Map(Object.entries(PH).map(([sha, p]) => [p.sha12, { sha, ...p }]));
const legacyPages = catalog.legacy.pages;
const pageBySlug = new Map(legacyPages.map((p) => [p.slug, p]));

/** Listing / guide / product sets straight from seed-dev.mjs (array literals evaluated with stubbed helpers). */
function seedArray(name) {
  const src = readFileSync(SEED_DEV, 'utf8');
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) fail(`seed-dev.mjs has no ${name} array`);
  let depth = 0;
  let i = src.indexOf('[', start);
  const from = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  // eslint-disable-next-line no-new-func
  return new Function('at', 'day', `return ${src.slice(from, i + 1)};`)(() => null, () => null);
}
const PROPERTIES = seedArray('PROPERTIES');
const GUIDES = seedArray('GUIDES');
const PRODUCTS = seedArray('PRODUCTS');
const TRAVELERS = seedArray('TRAVELERS');
const NEW_HOSTS = seedArray('NEW_HOSTS');

// ───────────────────────────────────────────────────────────── served files (size, sha256, dimensions)
function dims(buf, ext) {
  if (ext === 'webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (fourcc === 'VP8L') {
      const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (fourcc === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (ext === 'gif' && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (ext === 'ico') return { width: buf[6] || 256, height: buf[7] || 256 };
  if (ext === 'svg') {
    const s = buf.toString('utf8');
    const w = s.match(/<svg[^>]*\swidth="([\d.]+)/)?.[1];
    const h = s.match(/<svg[^>]*\sheight="([\d.]+)/)?.[1];
    if (w && h) return { width: Math.round(+w), height: Math.round(+h) };
    const vb = s.match(/viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/);
    if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
  }
  return null;
}
const MIME = { webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon', jpg: 'image/jpeg', png: 'image/png' };
const fileInfo = new Map();
function served(url) {
  if (fileInfo.has(url)) return fileInfo.get(url);
  const f = path.join(PUBLIC, ...url.split('/').filter(Boolean));
  if (!existsSync(f)) fail(`served file missing: apps/web/public${url}`);
  const buf = readFileSync(f);
  const ext = path.extname(f).slice(1).toLowerCase();
  const d = dims(buf, ext);
  if (!d) fail(`cannot read dimensions of ${url}`);
  const info = { bytes: statSync(f).size, sha256: createHash('sha256').update(buf).digest('hex'), mime: MIME[ext] ?? 'application/octet-stream', ...d };
  fileInfo.set(url, info);
  return info;
}

// ───────────────────────────────────────────────────────────── usage registry (what is shown where)
const used = new Map(); // public url → Set(context)
const useAt = (url, ctx) => (used.get(url) ?? used.set(url, new Set()).get(url)).add(ctx);
const photo = (s12) => {
  const p = photoBy12.get(s12);
  if (!p) fail(`unknown photo ${s12}`);
  if (!p.accepted || p.shown === false) fail(`photo ${s12} is not accepted for display`);
  if (/nd/i.test(p.license ?? '') || /-nd/i.test(p.licenseLabel ?? '')) fail(`photo ${s12} is ND-licensed (${p.licenseLabel})`);
  return p;
};
const legacy = (s12) => {
  const a = legacyBy12.get(s12) ?? LEG[s12];
  if (!a) fail(`unknown legacy medium ${s12}`);
  return a;
};
/** 'P:sha12' | 'L:sha12' | sha12 (photo first) → public url (the 960 rendition or the best served one). */
const urlOf = (ref) => {
  const [k, s] = ref.includes(':') ? ref.split(':') : [photoBy12.has(ref) ? 'P' : 'L', ref];
  return k === 'P' ? photo(s).src : legacy(s).src;
};
const legacyUrl = (sha) => LEG[sha].src;
const photoByUrl = new Map([...photoBy12.values()].map((p) => [p.src, p]));
const legacyByUrl = new Map(Object.entries(LEG).map(([sha, a]) => [a.src, { sha, ...a }]));
const altOf = (url) => photoByUrl.get(url)?.alt ?? legacyByUrl.get(url)?.alt ?? '';
const accepted = [...photoBy12.values()].filter((p) => p.accepted && p.shown !== false && !/nd/i.test(p.license ?? ''));
const withRole = (role) => accepted.filter((p) => (p.roles ?? []).includes(role));

// ───────────────────────────────────────────────────────────── stays
// Cover (photo 1): curated per listing — exterior or neighbourhood photo of the listing's city that matches its type.
const STAY_COVERS = {
  'seoul-hanok': 'ec2e02bd8215', // Bukchon hanok alley framing N Seoul Tower
  'seoul-apt': '368fa3dae297', // Han River bridge at blue hour (Seongsu riverside)
  'jeju-villa': '210d3f5e8f15', // modern villa above the sea, Aewol
  'busan-home': '43eaeecfb9b5', // Haeundae Beach beneath its towers
  'seoul-mangwon-house': '0c8911c463cf', // Han River lights (Mangwon riverside)
  'seoul-yeonnam-studio': 'ef53fe2bf321', // Hongdae café
  'seoul-hannam-villa': 'dadcf1a8c937', // downtown skyline from Namsan
  'seoul-jamsil-apt': 'ef142971f7d4', // Lotte World Tower skyline
  'seoul-seochon-hanok': '7ed8a020f394', // hanok with wooden doors on a city lane
  'busan-gwangalli-ocean': '24cbec20bf45', // Gwangan Bridge at night
  'busan-yeongdo-guesthouse': '07f4bab697ba', // Busan hillside village houses
  'busan-gijang-villa': '9b8211df405c', // infinity pool meeting the sea
  'jeju-hallim-stone-house': '3affcafcd0d2', // stone walls and thatched houses, west Jeju
  'jeju-seogwipo-apt': 'f0b6002a5c33', // southwest coast with Sanbangsan
  'jeju-gujwa-studio': '0ea9a84a78b3', // turquoise east-coast beach
  'gangneung-anmok-apt': 'a6ce38628cb0', // emerald waves, Gangneung coast
  'gangneung-gyeongpo-house': 'b263169728d9', // swing bench on a Gangneung beach
  'sokcho-seorak-cabin': '37cb7dbf7c32', // Seoraksan ridges to the Sokcho coast
  'sokcho-harbor-studio': '68d55cfa71f3', // early-morning waves, Sokcho
  'gyeongju-hwangnam-hanok': 'f90db310072e', // hanok gate and brick wall
  'gyeongju-bomun-villa': '781a27c949a2', // Gyeongju pagodas at sunset
  'jeonju-hanok-village': 'f1bd1cf21288', // Jeonju hanok rooftops
  'jeonju-gaeksa-room': '7e7c4f4bed14', // Jeonju hanok village gatehouse
  'yeosu-dolsan-ocean': 'bee3cc3c82e1', // terrace above a deep-blue sea
};
const TYPE_EXTERIOR = { HANOK: ['hanok'], VILLA: ['villa', 'beach'], HOUSE: ['house'], APARTMENT: ['beach'], STUDIO: ['beach'], GUESTHOUSE: ['house'], ROOM: ['house'] };
const OCEAN_RE = /바다|오션|해변|해수욕장|광안|해운대|해안/;
const LABEL = { exterior: '동네 풍경', living: '거실', studio: '스튜디오', lounge: '공용 라운지', bedroom: '침실', kitchen: '주방', bathroom: '욕실', balcony: '발코니 전망', pool: '수영장' };

function stayTraits(p) {
  const text = `${p.title} ${p.summary} ${p.description}`;
  return {
    hanok: p.type === 'HANOK',
    studio: p.type === 'STUDIO',
    room: p.type === 'GUESTHOUSE' || p.type === 'ROOM',
    villa: p.type === 'VILLA',
    house: p.type === 'HOUSE',
    pool: (p.amenities ?? []).includes('pool'),
    ocean: OCEAN_RE.test(text),
    terrace: /테라스|발코니/.test(text) && OCEAN_RE.test(text),
    family: /아이 방|이층 침대/.test(text),
    fireplace: /난로|캐빈|통나무/.test(text),
    twin: p.type === 'GUESTHOUSE',
    city: p.city === 'Seoul' || /아파트|레지던스/.test(p.title),
  };
}
function slotsFor(t) {
  const fifth = t.pool ? 'pool' : t.terrace && !t.room ? 'balcony' : 'bathroom';
  if (t.studio) return ['studio', 'kitchen', 'bedroom', fifth];
  if (t.room) return ['bedroom', 'lounge', 'kitchen', 'bathroom'];
  return ['living', 'bedroom', 'kitchen', fifth];
}
const POOL_ROLE = { living: 'stay-interior:living', studio: 'stay-interior:studio', lounge: 'stay-interior:living', bedroom: 'stay-interior:bedroom', kitchen: 'stay-interior:kitchen', bathroom: 'stay-interior:bathroom', balcony: 'stay-interior:balcony', pool: 'stay-interior:pool' };
function prefBonus(slot, t, p) {
  const s = `${p.subjectEn ?? ''} ${p.title ?? ''}`;
  let b = 0;
  if (slot === 'living' && t.hanok && /hanok|maru/i.test(s)) b += 60;
  if ((slot === 'studio' || slot === 'bedroom') && t.studio && (p.roles ?? []).includes('stay-interior:studio')) b += 25;
  if (slot === 'kitchen' && (t.studio || t.room) && /kitchenette|compact/i.test(s)) b += 30;
  if (slot === 'kitchen' && (t.villa || t.house) && /spacious|open|beams|butcher/i.test(s)) b += 10;
  if (slot === 'bedroom' && t.family && /kids/i.test(s)) b += 40;
  if (slot === 'bedroom' && !t.family && /kids/i.test(s)) b -= 30;
  if (slot === 'bedroom' && t.twin && /twin|two beds/i.test(s)) b += 40;
  if (slot === 'bedroom' && !t.twin && /twin|two beds/i.test(s)) b -= 25;
  if (!t.ocean && /ocean|sea\b|beach|surf/i.test(s)) b -= 40;
  if (slot === 'bedroom' && t.ocean && /ocean|sea|beach|veranda/i.test(s)) b += 20;
  if (slot === 'bedroom' && t.city && /high-rise|city|condo/i.test(s)) b += 12;
  if ((slot === 'living' || slot === 'bedroom') && t.fireplace && /fireplace|wood/i.test(s)) b += 20;
  if (slot === 'living' && (t.villa || t.house) && /deck|wood ceiling|fireplace/i.test(s)) b += 8;
  if (slot === 'lounge' && /sofa|lounge|living/i.test(s)) b += 5;
  if (slot === 'balcony' && /balcony|terrace|veranda/i.test(s)) b += 10;
  if (slot === 'pool' && t.ocean && /sea|private villa/i.test(s)) b += 15;
  if (/close-up|cushion|hallway|table/i.test(s) && slot !== 'kitchen') b -= 30;
  return b;
}

const stays = {};
const coverUsed = new Set();
const coverOf = new Set(Object.values(STAY_COVERS));
const interiorUses = new Map();
for (const p of PROPERTIES) {
  const t = stayTraits(p);
  let cover = STAY_COVERS[p.slug] ? photo(STAY_COVERS[p.slug]) : null;
  if (!cover) {
    // fallback for listings added to seed-dev later: exterior of the same type in the same city, then type, then city
    const exts = (TYPE_EXTERIOR[p.type] ?? ['house']).flatMap((k) => withRole(`stay-exterior:${k}`));
    const city = withRole(`city:${p.city}`);
    const cand = [...exts.filter((x) => (x.roles ?? []).includes(`city:${p.city}`)), ...exts, ...city].filter((x) => !coverUsed.has(x.sha12));
    cover = cand.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || a.sha12.localeCompare(b.sha12))[0];
    if (!cover) fail(`no cover photo left for ${p.slug}`);
  }
  if (coverUsed.has(cover.sha12)) fail(`cover ${cover.sha12} used twice (${p.slug})`);
  coverUsed.add(cover.sha12);
  const photos = [{ slot: 'exterior', p: cover }];
  for (const slot of slotsFor(t)) {
    const taken = new Set(photos.map((x) => x.p.sha12));
    // hanoks: the maru hall photo (tagged as a hanok exterior) is their living room; other listings' covers are never interiors
    const extra = slot === 'living' && t.hanok ? withRole('stay-exterior:hanok').filter((x) => /maru|hall/i.test(x.subjectEn ?? '')) : [];
    const cand = uniq([...withRole(POOL_ROLE[slot]), ...extra]).filter((x) => !taken.has(x.sha12) && !coverOf.has(x.sha12));
    const score = (x) => (x.quality ?? 3) * 10 + prefBonus(slot, t, x) - (interiorUses.get(x.sha12) ?? 0) * 22;
    const best = cand.sort((a, b) => score(b) - score(a) || a.sha12.localeCompare(b.sha12))[0];
    if (!best) fail(`no ${slot} photo for ${p.slug}`);
    interiorUses.set(best.sha12, (interiorUses.get(best.sha12) ?? 0) + 1);
    photos.push({ slot, p: best });
  }
  stays[p.slug] = {
    propertyId: uid(`property:${p.slug}`),
    city: p.city,
    type: p.type,
    photos: photos.map(({ slot, p: x }, i) => {
      const url = x.src;
      useAt(url, `stay:${p.slug}`);
      return { slot, url, caption: clip(i === 0 ? `${LABEL.exterior} · ${x.alt}` : `${LABEL[slot]} · ${x.alt}`, 200), alt: x.alt };
    }),
  };
}

// ───────────────────────────────────────────────────────────── guides (scene covers only)
const GUIDE_COVERS = {
  'guide-friend': 'e640fa069504', // Hongdae design café
  'guide-pro': 'ca9d5d43185b', // Gyeonghoeru Pavilion, Gyeongbokgung
  'guide-busan': 'd13c73a7f8bd', // Gamcheon Culture Village
  'guide-jeju': '7ba74645a19e', // canola fields and stone walls
  'guide-gyeongju': 'adb89289f8e9', // Bulguksa stairway
  'guide-jeonju': '54f015fcf85f', // hand-painted kettles, Jeonju village craft shop
  'guide-gangneung': '95919e788ff3', // café window seat
  'guide-jejupro': '3617260a8aaa', // lava-tube cave (Manjanggul)
};
const guides = {};
for (const g of GUIDES) {
  let p = GUIDE_COVERS[g.key] ? photo(GUIDE_COVERS[g.key]) : null;
  if (!p) {
    const cand = (g.interests ?? []).flatMap((i) => withRole(`guide-cover:${i}`));
    p = [...cand.filter((x) => (x.roles ?? []).includes(`city:${g.city}`)), ...cand, ...withRole(`city:${g.city}`)][0];
  }
  if (!p) fail(`no guide cover for ${g.key}`);
  useAt(p.src, `guide:${g.key}`);
  guides[g.key] = { userId: uid(`user:${g.key}`), city: g.city, url: p.src, alt: p.alt };
}

// ───────────────────────────────────────────────────────────── people (profile photos)
// Every seeded person — host, guide, traveller — gets a real portrait from data/media/people.json instead of an
// initial. The portrait is a STAND-IN chosen to fit the persona's age and the way the demo describes them; it is
// never a photo of that person, and its credit is shown on /credits like every other licensed photo.
const PERSON_PHOTOS = {
  // hosts
  'host-a': '8381251812dd', // 서울 호스트 — woman at an office desk, 40s
  'host-b': '9bcf7f4aae53', // 제주 호스트 — man laughing, 30s
  exchanger: '0a6b9872d334', // 부산 교환회원 — woman with sunglasses pushed up, 30s
  'host-gangwon': '8bc151a71412', // 강원 바다숲 스테이 — bearded man in a red jumper, 30s
  'host-hanok': '6fe27bf8d7f1', // 한옥스테이 소담 — elderly woman in a lane
  'host-namhae': 'f302406d6b50', // 남해안 오션스테이 — older man with a hat
  // guides
  'guide-friend': '6fefb3ad4091', // Local Friend Mina — young woman smiling outdoors
  'guide-pro': '38dd30a01d43', // Pro Guide Jun — older man in a jacket
  'guide-busan': 'c01253346c86', // 해설봉사 현우 — older man waving in an alley
  'guide-jeju': 'fd5737c73cc5', // 제주 친구 소라 — young woman, dark background
  'guide-gyeongju': '28e1354ad347', // 경주 문화해설 지훈 — young man under winter trees
  'guide-jeonju': 'f24b53f7e1cd', // 전주 한옥 지킴이 은영 — woman laughing, 50s
  'guide-gangneung': 'a3e21a324242', // 강릉 커피 큐레이터 도윤 — young man in a cap
  'guide-jejupro': '64748a6fb597', // Jeju Pro Guide Grace — woman with glasses
  // travellers
  'traveler-seoyeon': 'b8ebb7de4cde', // 이서연 — young woman, pink backdrop
  'traveler-junho': '1b902cb04698', // 박준호 — man on a terrace, 40s
  'traveler-emma': '4aac3924d86c', // Emma Wilson — woman in a red sweater
  'traveler-minji': '22c23a97a22f', // 최민지 — person in a grey jacket
  'traveler-takeshi': 'bbc9c0fb01bf', // Takeshi Sato — young man on the street
  'traveler-haneul': '458965ccc5f4', // 정하늘 — young man in a white shirt
  'traveler-lucas': '2875bf17d1cf', // Lucas Martin — man with glasses
  'traveler-jiwoo': 'd44f23e3cb25', // 한지우 — woman in a kitchen
  guest: 'd500c3062766', // 여행자 김 — man in a blazer, 40s
};
// the two legacy guides are named where seed-dev creates their user, not in the GUIDES array
const GUIDE_SEED_NAMES = { 'guide-friend': 'Local Friend Mina', 'guide-pro': 'Pro Guide Jun' };
const PERSONS = [
  ...[['host-a', '서울 호스트'], ['host-b', '제주 호스트'], ['exchanger', '부산 교환회원']].map(([key, name]) => ({ key, name, role: 'host' })),
  ...NEW_HOSTS.map(([key, , name]) => ({ key, name, role: 'host' })),
  ...GUIDES.map((g) => ({ key: g.key, name: g.name ?? GUIDE_SEED_NAMES[g.key], role: 'guide' })),
  ...TRAVELERS.map(([key, , name]) => ({ key, name, role: 'traveler' })),
  { key: 'guest', name: '여행자 김', role: 'traveler' },
];
const portraits = accepted.filter((p) => p.collection === 'person').sort((a, b) => a.sha12.localeCompare(b.sha12));
// every published portrait is reachable (assigned below, or picked by the web for a person the seed does not know)
portraits.forEach((p) => useAt(p.src, 'person:pool'));
const portraitUsed = new Set();
/** Curated portrait for a person, else the least-used one picked deterministically from the person's key. */
function portraitFor(key) {
  const curated = PERSON_PHOTOS[key];
  if (curated) return photo(curated);
  if (!portraits.length) fail(`no portraits available for ${key} — run node scripts/legacy/fetch-people.mjs publish`);
  const free = portraits.filter((p) => !portraitUsed.has(p.sha12));
  const pool = free.length ? free : portraits;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return pool[(h >>> 0) % pool.length];
}
const people = {};
if (portraits.length) {
  for (const { key, name, role } of PERSONS) {
    const p = portraitFor(key);
    if (p.collection !== 'person') fail(`portrait of ${key} (${p.sha12}) is not a person photo`);
    portraitUsed.add(p.sha12);
    useAt(p.src, `person:${key}`);
    people[key] = { userId: uid(`user:${key}`), name, role, url: p.src, alt: p.alt };
  }
  const dup = Object.entries(people).filter(([, a], i, xs) => xs.findIndex(([, b]) => b.url === a.url) !== i);
  if (dup.length) fail(`two people share a portrait: ${dup.map(([k]) => k).join(', ')}`);
}

// ───────────────────────────────────────────────────────────── travel products (seed-dev catalogue)
const PRODUCT_PHOTOS = {
  'jeju-oreum-sunrise': ['63a616a26a55', 'b82bcb4f2bef', 'e55fb9e4d9db', '0f3cb542ec62'],
  'seoul-palace-moonlight': ['866f3d3a3f7c', '2ad32bd0dbdb', 'bf3bca06b2da', '870732586138'],
  'busan-yacht-sunset': ['fdc9264cabb5', '723b49a779d1', '73492ac113f5', '55064453af35'],
  'gyeongju-heritage-bike': ['25860767e7f4', 'c0ae9b2fbe8b', '9601d5cc1f89', 'e78c5b82467e'],
  'jeonju-hanok-cooking': ['55700aaceb05', '5d21efaf90d3', '9f36926e36a7'],
  'gangneung-coffee-trail': ['d9f6b59adb06', 'e892c73c09ae', 'e21162f7fcd3'],
  'yeosu-cablecar-ticket': ['3e081aa86a24', '9fd2227fe878'],
  'jeju-east-3day-package': ['a03fab7a0e5c', '8526760b95f8', '49cdcc5702da', 'a4c49e26a1b8'],
};
const THEME_OF = { TOUR: ['travel:hiking', 'travel:culture'], ACTIVITY: ['travel:food', 'travel:boat'], TICKET: ['travel:boat'], PACKAGE: ['travel:sunrise'] };
const products = {};
for (const p of PRODUCTS) {
  let refs = PRODUCT_PHOTOS[p.slug];
  if (!refs) refs = [...withRole(`city:${p.city}`), ...(THEME_OF[p.type] ?? []).flatMap(withRole)].slice(0, 3).map((x) => x.sha12);
  const urls = refs.map((r) => photo(r).src);
  urls.forEach((u) => useAt(u, `product:${p.slug}`));
  products[p.slug] = { productId: p.legacy ? uid('product:jeju-oreum') : uid(`product:${p.slug}`), urls };
}

// ───────────────────────────────────────────────────────────── migrated wontc.co.kr pages → CMS entries
const PAGE_SLUGS = {
  about_jetpool: 'about-jetpool', about_wontc: 'about-wontc', about_ceo: 'about-ceo', local_life: 'local-life', member_stay: 'member-stay',
  jetpool: 'jetpool-host', 'untitled-1': 'charter-platform', tour_ticket: 'tour-ticket', tour_consulting: 'tour-consulting', cs: 'customer-center', won_story: 'won-story',
};
const LEGACY_CONTENT_SLUGS = {
  index: 'wontc-home', about_letter: 'about-letter', 'untitled-6': 'hanging-gardens-of-bali',
  guide: 'sixshop-guide', notice_guide: 'sixshop-notice-guide', qna_guide: 'sixshop-qna-guide', review_guide: 'sixshop-review-guide',
};
// past WONT tour products: legacy page → product (+ a LEGACY_CONTENT entry with the full page)
const WONT_PRODUCTS = {
  product_past_operafestival: { slug: 'wont-opera-festival', type: 'PACKAGE', country: 'FR', city: 'Orange', days: 13, status: 'ARCHIVED',
    title: '오페라 페스티벌 (프랑스 외 2개국 11박 13일)', summary: '엑상프로방스·오랑주·뮌헨·브레겐츠 오페라 페스티벌 5회 관람과 남프랑스·아비뇽 와이너리 투어' },
  product_past_pilgrimage: { slug: 'wont-luther-pilgrimage', type: 'PACKAGE', country: 'DE', city: 'Wittenberg', days: 10, status: 'ARCHIVED',
    title: '마틴 루터 종교개혁 성지순례 (독일 외 4개국 8박 10일)', summary: '비텐베르크·아이제나흐·드레스덴·하이델베르크 — 종교개혁가 마틴 루터의 발자취를 따라가는 성지순례' },
  product_past_spainbest: { slug: 'wont-spain-gastronomy', type: 'PACKAGE', country: 'ES', city: 'Seville', days: 13, status: 'ARCHIVED',
    title: '미식과 미학의 베스트 스페인 (11박 13일)', summary: '미슐랭 스타 셰프의 요리와 세비야·그라나다·론다·바르셀로나, 이베리아 반도를 다양한 교통수단으로 잇는 미식 여행' },
  'product_past_spainbest-30': { slug: 'wont-canada-healing', type: 'PACKAGE', country: 'CA', city: 'Niagara Falls', days: 15, status: 'ARCHIVED',
    title: '캐나다 힐링 여행 — 캐나다의 모든 것 살아보기', summary: '일년 단 한번의 특별함, 캐나다 눈꽃세상으로의 시간여행 (15일 살아보기)' },
  'product_past_spainbest-30-31': { slug: 'wont-sapporo-snow-festival', type: 'PACKAGE', country: 'JP', city: 'Sapporo', days: 4, status: 'ARCHIVED',
    title: '나태주 시인과 함께하는 삿포로 눈축제 (3박 4일)', summary: '2025년 2월 진행 완료 — 나태주 시인과 함께한 삿포로 눈축제·노보리베츠 온천·도야호·오타루 겨울 여행' },
  'product_past_spainbest-30-31-32': { slug: 'wont-barcelona-humanities', type: 'PACKAGE', country: 'ES', city: 'Barcelona', days: 8, status: 'PUBLISHED', price: 4500000,
    title: '유영만 교수와 함께 떠나는 8일간의 바르셀로나 문화 인문학 여행', summary: '가우디 건축과 피카소·미로, 스케치·모자이크·플라멩코 워크숍까지 — 원여행클럽 인문학 여행 (2025년 7월 일정 진행, 다음 출발은 상담으로 안내)' },
};
const COPY_OF = { 'product_past_operafestival-28': 'product_past_operafestival' };
const legacyContentSlug = (s) => LEGACY_CONTENT_SLUGS[s] ?? WONT_PRODUCTS[s]?.slug ?? (COPY_OF[s] ? `${WONT_PRODUCTS[COPY_OF[s]].slug}-copy` : null);
const letterSlug = (p) => (p.letterNo ? `heart-letter-${p.letterNo}` : null);

function entryOf(p) {
  if (PAGE_SLUGS[p.slug]) return { type: 'PAGE', slug: PAGE_SLUGS[p.slug], route: `/about/${PAGE_SLUGS[p.slug]}` };
  if (p.kind === 'heart-letter') return { type: 'STORY', slug: letterSlug(p), route: `/stories/${letterSlug(p)}` };
  const s = legacyContentSlug(p.slug);
  if (!s) fail(`no CMS mapping for legacy page ${p.slug}`);
  return { type: 'LEGACY_CONTENT', slug: s, route: `/stories/${s}` };
}
const ENTRY = new Map(legacyPages.map((p) => [p.slug, entryOf(p)]));
// links in the migrated markdown point at the catalog's provisional /stories/legacy-* routes → the real entries
const ROUTE_REWRITE = new Map(legacyPages.flatMap((p) => uniq([p.cms.entryRoute, p.cms.targetRoute]).filter((r) => r.startsWith('/stories/legacy-') || r.startsWith('/p/legacy-')).map((r) => [r, ENTRY.get(p.slug).route])));
const ORIGIN = catalog.legacy.site.origin;

function readPageMd(slug) {
  const f = path.join(PAGES_DIR, `${slug}.md`);
  if (!existsSync(f)) fail(`missing ${path.relative(ROOT, f)}`);
  let md = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  md = md.replace(/^---\n[\s\S]*?\n---\n+/, ''); // front matter
  md = md.replace(/^# .*\n+/, ''); // the H1 repeats the entry title
  md = md.replace(/\]\((\/(?:stories|p)\/legacy-[a-z0-9-]+)\)/g, (m, r) => (ROUTE_REWRITE.has(r) ? `](${ROUTE_REWRITE.get(r)})` : m));
  if (/\]\(\/(stories|p)\/legacy-/.test(md)) fail(`unrewritten legacy link left in ${slug}.md`);
  return md.trim();
}
const mdImages = (md) => [...md.matchAll(/!\[[^\]]*\]\((\/(?:legacy|photos)\/[^)\s]+)\)/g)].map((m) => m[1]);
const SUMMARY = {
  index: '반값항공권과 공짜숙박으로 전세계 살아보기 — 원여행클럽 홈페이지 첫 화면',
  jetpool: '전세기 항공·해외여행 플랫폼·핀테크를 잇는 젯풀호스트 프랜차이즈 사업 안내',
  won_story: '원여행클럽 소개, CEO 원치승, 마음편지, 여행 컨설팅 — 원여행클럽이 걸어온 이야기',
  tour_ticket: '투어, 패스, 티켓 — 원여행클럽의 테마 여행 프로그램 모음',
  member_stay: '클럽 멤버에게만 제공되는 혜택 — 원여행클럽 멤버 스테이',
  cs: '원여행클럽 고객센터 연락처와 원본 페이지 보관',
};
const TITLE = { 'untitled-6': 'Hanging Gardens of Bali', index: '원여행클럽 — 전세계 살아보기, 비행기공유플랫폼' };
// about_jetpool only had grey placeholders; /cs only Sixshop sample photos (soap) — a WONT mailbox photo fits a contact page
const HERO_FALLBACK = { about_jetpool: 'd1646ef0f1e9', cs: 'a44a241acf0d' };
const summaryOf = (p) => {
  if (SUMMARY[p.slug]) return SUMMARY[p.slug];
  if (p.description) return p.description;
  if (p.kind === 'heart-letter') return `${p.title.replace(/^\[마음편지\s*\d+\]\s*/, '')} — 원치승 대표의 마음편지 ${Number(p.letterNo)}호${p.date ? ` (${p.date})` : ''}`;
  if (p.template) return '식스샵 템플릿 안내 페이지 — 원본 사이트에 남아 있던 그대로 보관';
  const para = (p.blocks ?? []).filter((b) => b.type === 'paragraph').map((b) => b.text.replace(/\s*\n\s*/g, ' ').trim());
  return para.find((t) => t.length >= 12 && !/^\[(모집|종료|모집중)/.test(t) && !/^진행 완료/.test(t)) ?? p.title;
};
const pubAt = (p) => (p.date && /^\d{4}\.\d{2}\.\d{2}$/.test(p.date) ? `${p.date.replace(/\./g, '-')}T10:00:00+09:00` : '2026-10-08T10:00:00+09:00');
const UI = new Set(['ui-element']);
const isVisual = (sha) => !UI.has(LEG[sha].category) && !LEG[sha].siteChrome;

const cms = [];
const legacyProducts = [];
for (const p of legacyPages) {
  const e = ENTRY.get(p.slug);
  let body = readPageMd(p.slug);
  const isTemplate = !!p.template;
  const heroSha = HERO_FALLBACK[p.slug] ? legacy(HERO_FALLBACK[p.slug]).sha : p.cover ?? p.coverAsset ?? p.assets.find(isVisual) ?? null;
  const heroUrl = heroSha ? legacyUrl(heroSha) : null;
  // page gallery: what the page showed (cover, inline images, extras) without size-duplicates, grey placeholders or
  // thumbnails that belong to other pages; data.media keeps the complete list (every medium found on the page).
  const alt = new Set(p.alternateAssets ?? []);
  const related = new Set(p.relatedAssets ?? []);
  const gallery = uniq(p.assets.filter((s) => !alt.has(s) && !related.has(s) && (isTemplate || isVisual(s))).map(legacyUrl));
  const media = p.assets.map((s) => ({ url: legacyUrl(s), role: alt.has(s) ? 'rendition' : related.has(s) ? 'related' : s === p.coverAsset ? 'cover' : (p.contentAssets ?? []).includes(s) ? 'inline' : 'extra' }));
  if (p.slug === 'cs') {
    // The legacy /cs page only carried Sixshop sample content; the real WONT customer-centre details were in the footer.
    const f = catalog.legacy.site.footer ?? {};
    body = [
      '## 원여행클럽 고객센터',
      `- 전화: ${f.phone ?? '02. 6672. 0055'} (주말·공휴일 제외 10:00 - 18:00)`,
      f.email ? `- 이메일: ${f.email}` : null,
      f.address ? `- 주소: ${f.address}` : null,
      f.businessNumber ? `- 사업자등록번호: ${f.businessNumber} · 대표 ${f.ceo ?? '원치승'}` : null,
      '',
      'JETPOOL에서의 숙소·가이드·투어 예약과 결제는 플랫폼 결제로만 진행됩니다. 예약 관련 문의는 [고객지원](/support)에서 남겨 주세요.',
      '',
      '## 원본 페이지 보관',
      '',
      body,
    ]
      .filter((x) => x !== null)
      .join('\n');
  }
  const embeds = (p.embeds ?? []).slice();
  const summary = clip(summaryOf(p), 200);
  const data = {
    legacyUrl: p.legacyUrl,
    legacyPath: p.path,
    heroUrl,
    coverUrl: heroUrl,
    gallery,
    embeds,
    media,
    legacy: { system: 'LEGACY_WONT', path: p.path, kind: p.kind, page: p.slug },
    ...(isTemplate ? { template: true } : {}),
    ...(p.letterNo ? { series: '마음편지', letterNo: p.letterNo, date: p.date } : {}),
    ...(p.price ? { legacyPrice: p.price } : {}),
    tags: p.kind === 'heart-letter' ? ['마음편지', '원여행클럽'] : p.kind === 'tour-product' ? ['원여행클럽', '지난 여행'] : ['원여행클럽'],
  };
  const title = TITLE[p.slug] ?? p.title;
  cms.push({
    type: e.type,
    slug: e.slug,
    route: e.route,
    title,
    summary,
    bodyMd: body,
    heroUrl,
    publishedAt: pubAt(p),
    legacyPath: p.path,
    legacyUrl: p.legacyUrl,
    externalId: `wontc.co.kr${p.path}`,
    seo: {
      title: clip(`${title} | 원여행클럽 → JETPOOL`, 120),
      description: clip(summary, 160),
      canonical: e.route,
      ...(isTemplate ? { noindex: true } : {}),
      og: { ...(heroUrl ? { image: heroUrl } : {}), type: 'article' },
    },
    data,
  });
  for (const u of uniq([...mdImages(body), ...gallery, ...media.map((m) => m.url), heroUrl])) useAt(u, `cms:${e.type}:${e.slug}`);
  const wp = WONT_PRODUCTS[p.slug];
  if (wp) {
    const prodMedia = uniq([heroSha, ...(p.contentAssets ?? []), ...(p.extraAssets ?? [])].filter((s) => s && isVisual(s)).map(legacyUrl));
    prodMedia.forEach((u) => useAt(u, `product:${wp.slug}`));
    const description = [
      wp.summary,
      '',
      clip((p.text ?? '').replace(/\[(모집중|모집|종료)\]\s*/g, ''), 1500),
      '',
      `원여행클럽(WON TRAVEL CLUB)이 진행한 여행 프로그램입니다. 원본: ${p.legacyUrl}`,
      wp.status === 'PUBLISHED' ? '다음 출발 일정과 요금은 여행 상담으로 안내해 드립니다.' : '진행이 끝난 프로그램으로 예약할 수 없습니다.',
    ].join('\n');
    legacyProducts.push({
      slug: wp.slug,
      productId: uid(`product:${wp.slug}`),
      legacyPage: p.slug,
      legacyPath: p.path,
      type: wp.type,
      title: wp.title,
      summary: wp.summary,
      description,
      city: wp.city,
      country: wp.country,
      durationMinutes: wp.days * 1440,
      basePriceMinor: wp.price ?? null,
      status: wp.status,
      cmsSlug: e.slug,
      media: prodMedia,
    });
  }
}
// copies of a product page → the original product also shows their images
for (const [copy, orig] of Object.entries(COPY_OF)) {
  const lp = legacyProducts.find((x) => x.legacyPage === orig);
  const cp = pageBySlug.get(copy);
  if (lp && cp) for (const s of cp.contentAssets ?? []) if (isVisual(s) && !lp.media.includes(legacyUrl(s))) lp.media.push(legacyUrl(s));
}
const productRoute = (lp) => (lp.status === 'PUBLISHED' ? `/travel/${lp.productId}` : `/stories/${lp.cmsSlug}`);

// premium lounge (/untitled-7): the legacy page was empty — a short honest page with the lounge-themed legacy images
{
  const imgs = (catalog.usagePlan['charter:premium-lounge'] ?? []).map(legacyUrl);
  const skipped = catalog.legacy.skipped.find((s) => s.path === '/untitled-7');
  const body = [
    '## 프리미엄 라운지',
    '',
    "원여행클럽 사이트의 '프리미엄 라운지' 메뉴는 본문 없이 비어 있던 페이지입니다. 전세기 공유 여행과 멤버 스테이의 라운지·컨시어지 안내는 아래 페이지에서 이어집니다.",
    '',
    '- [전세기공유플랫폼](/about/charter-platform)',
    '- [멤버 스테이](/about/member-stay)',
    '- [JETPOOL 전세기 공유](/jetpool-charter)',
    '',
    ...imgs.flatMap((u) => [`![${altOf(u)}](${u})`, '']),
    '---',
    '',
    `*원본: ${ORIGIN}/untitled-7 · 원여행클럽(WON TRAVEL CLUB) 소유 콘텐츠, 소유자 승인 하에 이전*`,
  ].join('\n');
  imgs.forEach((u) => useAt(u, 'cms:PAGE:premium-lounge'));
  cms.push({
    type: 'PAGE', slug: 'premium-lounge', route: '/about/premium-lounge', title: skipped?.title ?? '프리미엄 라운지',
    summary: '전세기 공유 여행과 멤버 스테이의 라운지·컨시어지 안내', bodyMd: body, heroUrl: imgs[0] ?? null, publishedAt: '2026-10-08T10:00:00+09:00',
    legacyPath: '/untitled-7', legacyUrl: `${ORIGIN}/untitled-7`, externalId: 'wontc.co.kr/untitled-7',
    seo: { title: '프리미엄 라운지 | 원여행클럽 → JETPOOL', description: '전세기 공유 여행과 멤버 스테이의 라운지·컨시어지 안내', canonical: '/about/premium-lounge', og: { image: imgs[0], type: 'article' } },
    data: { legacyUrl: `${ORIGIN}/untitled-7`, legacyPath: '/untitled-7', heroUrl: imgs[0] ?? null, coverUrl: imgs[0] ?? null, gallery: imgs, embeds: [], media: imgs.map((url) => ({ url, role: 'inline' })),
      legacy: { system: 'LEGACY_WONT', path: '/untitled-7', kind: 'page', page: 'untitled-7', emptyOnLegacySite: true }, tags: ['원여행클럽'] },
  });
}

// site chrome (logo, favicon, default og:image, loader) belongs to the brand: shown on the about-wontc page
{
  const about = cms.find((c) => c.slug === 'about-wontc');
  const chrome = Object.keys(LEG).filter((s) => LEG[s].siteChrome);
  about.data.brand = Object.fromEntries(chrome.map((s) => [{ logo: 'logo', icon: 'favicon', 'brand-hero': 'ogDefault', 'ui-element': 'loader' }[LEG[s].category] ?? LEG[s].sha12, legacyUrl(s)]));
  about.data.media.push(...chrome.map((s) => ({ url: legacyUrl(s), role: 'brand' })));
  chrome.forEach((s) => useAt(legacyUrl(s), 'cms:PAGE:about-wontc'));
}

// ───────────────────────────────────────────────────────────── archive (every legacy medium) + brand-archive PAGE
const firstPageOf = (sha) => legacyPages.find((p) => p.assets.includes(sha)) ?? null;
const archiveOrder = uniq([...(catalog.usagePlan.archive ?? []), ...Object.keys(LEG)]);
const archive = archiveOrder.map((sha) => {
  const a = LEG[sha];
  const p = firstPageOf(sha);
  return {
    url: a.src,
    alt: a.alt ?? '',
    captionKo: a.subjectKo ?? a.subject ?? a.alt ?? '',
    page: p ? ENTRY.get(p.slug).route : '/about/about-wontc',
    pageTitle: p ? p.title : '원여행클럽 사이트 공통 요소',
    legacyPath: p ? p.path : null,
    category: a.category,
    ...(a.templateOnly ? { template: true } : {}),
    ...(a.siteChrome ? { siteChrome: true } : {}),
  };
});
{
  const gallery = archive.map((x) => x.url);
  const byCat = {};
  for (const x of archive) byCat[x.category] = (byCat[x.category] ?? 0) + 1;
  const body = [
    '## 원여행클럽 브랜드 아카이브',
    '',
    `원여행클럽(WON TRAVEL CLUB, ${ORIGIN.replace(/^https?:\/\//, '')})에서 JETPOOL로 이전한 이미지 ${gallery.length}점 전체를 원본 페이지와 함께 보관합니다. 사진마다 원래 실렸던 페이지로 이동할 수 있습니다.`,
    '',
    ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}점`),
    '',
    '---',
    '',
    '*원여행클럽(WON TRAVEL CLUB) 소유 콘텐츠, 소유자 승인 하에 이전 · 식스샵 템플릿 샘플 이미지는 원본 사이트에 남아 있던 그대로 보관용으로 함께 수록*',
  ].join('\n');
  const hero = legacyUrl(Object.keys(LEG).find((s) => LEG[s].sha12 === '2f6fa2db59f8') ?? archiveOrder[0]);
  gallery.forEach((u) => useAt(u, 'archive'));
  cms.push({
    type: 'PAGE', slug: 'brand-archive', route: '/about/brand-archive', title: '원여행클럽 브랜드 아카이브', summary: `wontc.co.kr에서 이전한 이미지 ${gallery.length}점 전체`,
    bodyMd: body, heroUrl: hero, publishedAt: '2026-10-08T10:00:00+09:00', legacyPath: null, legacyUrl: ORIGIN, externalId: 'wontc.co.kr/__archive__',
    seo: { title: '원여행클럽 브랜드 아카이브 | JETPOOL', description: `원여행클럽 사이트에서 이전한 이미지 ${gallery.length}점`, canonical: '/about/brand-archive', og: { image: hero, type: 'website' } },
    data: { legacyUrl: ORIGIN, heroUrl: hero, coverUrl: hero, gallery, embeds: catalog.legacy.embeds.map((e) => e.id), items: archive, legacy: { system: 'LEGACY_WONT', kind: 'archive' }, tags: ['원여행클럽', '아카이브'] },
  });
}

// ───────────────────────────────────────────────────────────── curated CMS (seed-dev entries), hero, charter, cities
const DESTINATIONS = { jeju: '454e72deb88a', seoul: 'f4a8954156cf', busan: 'a59a056f51ce', gangneung: 'e21162f7fcd3', gyeongju: 'c0ae9b2fbe8b', jeonju: 'f1bd1cf21288', sokcho: 'e47ee57a83ff', yeosu: '9fd2227fe878' };
const CITY_EN = { jeju: 'Jeju', seoul: 'Seoul', busan: 'Busan', gangneung: 'Gangneung', gyeongju: 'Gyeongju', jeonju: 'Jeonju', sokcho: 'Sokcho', yeosu: 'Yeosu' };
const destinations = {};
for (const [slug, s12] of Object.entries(DESTINATIONS)) {
  const cover = photo(s12);
  const more = withRole(`city:${CITY_EN[slug]}`).filter((x) => x.sha12 !== s12).sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || a.sha12.localeCompare(b.sha12)).slice(0, 7);
  const gallery = [cover, ...more].map((x) => x.src);
  gallery.forEach((u) => useAt(u, `cms:DESTINATION:${slug}`));
  destinations[slug] = { coverUrl: cover.src, gallery };
}
const STORY_COVERS = {
  'local-life-exchange': 'L:b2ca3f9720b6', // Paris apartment balcony (WONT home-exchange imagery)
  'seoul-busan-month-swap': 'P:7349fcefd4af',
  'jetpool-charter-story': 'L:2f6fa2db59f8',
  'local-life-jeonju-alleys': 'P:5d21efaf90d3',
  'gangneung-workation': 'P:e892c73c09ae',
  'jeju-hallim-winter': 'P:ab22e5e5408d',
  'wont-travel-club-history': 'L:943d1bd2c018',
};
const stories = {};
for (const [slug, ref] of Object.entries(STORY_COVERS)) {
  stories[slug] = { coverUrl: urlOf(ref) };
  useAt(stories[slug].coverUrl, `cms:STORY:${slug}`);
}
const PHOTO_ROLE_OK = (p) => p.collection === 'photo';
const charter = uniq(
  (catalog.usagePlan.charter ?? [])
    .filter((s) => (PH[s] && PH[s].accepted && PHOTO_ROLE_OK(PH[s])) || (LEG[s] && ['aircraft-charter', 'map'].includes(LEG[s].category)))
    .map((s) => (PH[s] ? photo(PH[s].sha12).src : legacyUrl(s))),
);
charter.forEach((u) => useAt(u, 'cms:PAGE:jetpool-charter'));
const pages = {
  'jetpool-charter': { heroUrl: urlOf('L:2f6fa2db59f8'), gallery: charter },
  'wont-home': { blocks: { 'month-exchange': urlOf('L:a8ec33054412'), charter: urlOf('L:9107e073b330'), 'local-life': urlOf('P:a62bb51a1571') } },
};
Object.values(pages['wont-home'].blocks).forEach((u) => useAt(u, 'cms:PAGE:wont-home'));
useAt(pages['jetpool-charter'].heroUrl, 'cms:PAGE:jetpool-charter');

const HERO = ['P:f4a8954156cf', 'L:2f6fa2db59f8', 'P:454e72deb88a', 'L:a8ec33054412', 'P:a59a056f51ce', 'L:06fb33a93e89', 'P:7ba74645a19e', 'L:486bd1c54129', 'P:65bcd5b6013a', 'L:13779e26d836', 'P:a3292cd333a9', 'L:c7f1763524ef'];
const hero = HERO.map(urlOf);
hero.forEach((u) => useAt(u, 'home:hero'));

// city → representative image (Korean cities: the destination covers; abroad: WONT destination scenery + photos)
const cities = Object.fromEntries(Object.entries(DESTINATIONS).map(([slug]) => [CITY_EN[slug], destinations[slug].coverUrl]));
const ABROAD = {
  Lisbon: 'P:326a851d79f0', Tokyo: 'P:955b87a6e705', 'Chiang Mai': 'P:d0ae73bd200a', Paris: 'L:963393184f56', Barcelona: 'L:ba0d5e4cb691', Sapporo: 'L:e875f0b9d7a9',
  Otaru: 'L:4762dea07457', Hokkaido: 'L:6203dc3048ef', Dubrovnik: 'L:a8ec33054412', 'Niagara Falls': 'L:486bd1c54129', 'Hoi An': 'L:f923edb5836c', Nagasaki: 'L:84b5dd634f1d',
  Dresden: 'L:153d436c72d9', Wittenberg: 'L:28589ae94170', Heidelberg: 'L:dced481110d9', Munich: 'L:ad406b7387ff', Bregenz: 'L:cc26c41a9e7f', Lyon: 'L:f5af5d924f78',
  Cologne: 'L:65df28841c37', Seville: 'L:a336f3f8d1d9', Granada: 'L:fe91e879f2f4', Ronda: 'L:f94faac29699', Milan: 'L:6380789e3826', Kotor: 'L:bb7977c0d0b4',
  Crete: 'L:81848e6e86d9', Bali: 'L:13779e26d836', Petra: 'L:c7f1763524ef',
};
for (const [c, ref] of Object.entries(ABROAD)) {
  cities[c] = urlOf(ref);
  useAt(cities[c], `city:${c}`);
}

// ───────────────────────────────────────────────────────────── redirects (legacy path → new path)
const KNOWN_WEB = new Set(['', 'stay', 'map', 'exchange', 'guide-friends', 'guides', 'guide-requests', 'guide-bookings', 'guide', 'travel', 'trip-planner', 'checkout', 'orders',
  'jetpool-charter', 'discover', 'stories', 'login', 'signup', 'auth', 'account', 'verification', 'reviews', 'saved', 'trips', 'messages', 'payments', 'notifications',
  'support', 'assistant', 'host', 'earnings', 'supplier', 'admin', 'api', 'about', 'archive', 'credits']);
const redirects = [];
const addRedirect = (legacyPath, targetPath, approved, note) => {
  if (!legacyPath || legacyPath === '/' || legacyPath === targetPath) return;
  if (KNOWN_WEB.has(legacyPath.split('/')[1] ?? '')) return; // a live route of the new site — never shadow it
  if (redirects.some((r) => r.legacyPath === legacyPath)) return;
  redirects.push({ legacyPath, targetPath, statusCode: 301, approved, note });
};
for (const p of legacyPages) {
  const e = ENTRY.get(p.slug);
  const lp = legacyProducts.find((x) => x.legacyPage === (COPY_OF[p.slug] ?? p.slug));
  const target = p.slug === 'index' ? '/' : lp ? productRoute(lp) : e.route;
  const exact = !p.template || e.type === 'PAGE'; // Sixshop sample pages (except the customer centre) wait for a business decision
  for (const lpath of [p.path, ...(p.aliases ?? [])]) addRedirect(lpath, target, exact, exact ? 'exact migrated page' : 'Sixshop template page — needs business review');
}
addRedirect('/untitled-7', '/about/premium-lounge', true, 'exact migrated page (empty on the legacy site)');
addRedirect('/all', '/travel', true, 'Sixshop all-products list → travel catalogue');
// seed-dev's earlier generic mapping of /jetpool (→ /jetpool-charter) is replaced by the exact migrated page
const REPLACES = { '/jetpool': '/jetpool-charter' };

// ───────────────────────────────────────────────────────────── assets table (every used url) + coverage
const allUrls = [...used.keys()].sort();
const assets = {};
for (const url of allUrls) {
  const info = served(url);
  const p = photoByUrl.get(url);
  const l = legacyByUrl.get(url);
  if (!p && !l) fail(`used url is neither a photo nor a legacy medium: ${url}`);
  assets[url] = {
    kind: p ? 'photo' : 'legacy',
    sha12: (p ?? l).sha12,
    sourceSha256: p ? p.sha : l.sha,
    sha256: info.sha256,
    bytes: info.bytes,
    width: info.width,
    height: info.height,
    mime: info.mime,
    alt: (p ?? l).alt ?? '',
    uses: [...used.get(url)].sort(),
  };
}
const legacyAll = Object.keys(LEG).map(legacyUrl);
const notArchived = legacyAll.filter((u) => !used.get(u)?.has('archive'));
const notContextual = legacyAll.filter((u) => ![...(used.get(u) ?? [])].some((c) => c !== 'archive'));
if (legacyAll.length !== 273) fail(`expected 273 legacy media, catalog has ${legacyAll.length}`);
if (notArchived.length) fail(`${notArchived.length} legacy media missing from the archive: ${notArchived.slice(0, 5).join(', ')}`);
if (notContextual.length) fail(`${notContextual.length} legacy media without a contextual placement: ${notContextual.slice(0, 5).join(', ')}`);
const photosUsed = allUrls.filter((u) => photoByUrl.has(u));
for (const u of photosUsed) {
  const p = photoByUrl.get(u);
  if (!p.accepted) fail(`unaccepted photo used: ${u}`);
  // CC BY / BY-SA need creator + licence + source; CC0 / PDM are still credited (source + licence) as a courtesy
  if (!p.credit || !p.attribution || !p.licenseUrl || !p.landingUrl || (p.requiresAttribution !== false && !p.creator)) fail(`photo without full attribution used: ${u}`);
}
const excludedSha = new Set((catalog.excluded ?? []).map((e) => e.sha));
for (const u of photosUsed) if (excludedSha.has(photoByUrl.get(u).sha)) fail(`excluded (ND) photo used: ${u}`);
const covers = Object.values(stays).map((s) => s.photos[0].url);
if (new Set(covers).size !== covers.length) fail('two listings share a cover photo');
for (const [slug, s] of Object.entries(stays)) if (s.photos.length !== 5) fail(`${slug} has ${s.photos.length} photos`);

const coverage = {
  legacyMediaTotal: legacyAll.length,
  archived: legacyAll.length - notArchived.length,
  contextual: legacyAll.length - notContextual.length,
  unused: notContextual,
  photosUsed: photosUsed.length,
  credited: photosUsed.length,
  stays: Object.keys(stays).length,
  stayPhotos: Object.values(stays).reduce((n, s) => n + s.photos.length, 0),
  distinctStayCovers: new Set(covers).size,
  guides: Object.keys(guides).length,
  people: Object.keys(people).length,
  portraits: portraits.length,
  products: Object.keys(products).length,
  legacyProducts: legacyProducts.length,
  cmsEntries: cms.length,
  redirects: redirects.length,
};

const assignments = {
  version: 1,
  generatedFrom: {
    catalog: 'data/media/catalog.json',
    catalogGeneratedAt: catalog.generatedAt,
    people: 'data/media/people.json',
    seed: 'packages/db/seed-dev.mjs',
  },
  readme:
    'Generated by scripts/legacy/assign.mjs — do not edit by hand. Applied to the database by packages/db/seed-media.mjs (seed-dev.mjs calls it). ' +
    'Public URLs are without the web basePath. stays[slug].photos[0] is the cover; people[key] is a seeded person’s profile photo ' +
    '(an openly-licensed portrait standing in for the persona); assets[url] holds the served file facts for media_assets rows.',
  coverage,
  stays,
  guides,
  people,
  products,
  legacyProducts,
  destinations,
  stories,
  pages,
  cms,
  redirects,
  replacesRedirects: REPLACES,
  hero,
  charter,
  cities,
  assets,
};

// ───────────────────────────────────────────────────────────── web media map
const photoEntry = (p) => ({
  srcset: p.srcset,
  placeholder: p.placeholder,
  width: served(p.src).width,
  height: served(p.src).height,
  colorAvg: p.colorAvg,
  alt: p.alt,
  credit: {
    title: p.title,
    creator: p.creator,
    creatorUrl: p.creatorUrl ?? null,
    license: p.licenseLabel,
    licenseCode: p.license,
    licenseUrl: p.licenseUrl,
    landingUrl: p.landingUrl,
    provider: p.provider ?? p.source ?? null,
    attribution: p.attribution,
    ko: p.credit?.ko ?? null,
  },
});
const legacyEntry = (a) => ({ srcset: a.srcset, placeholder: a.placeholder, width: served(a.src).width, height: served(a.src).height, colorAvg: a.colorAvg, alt: a.alt ?? '' });
const mediaMap = {
  version: 1,
  generatedFrom: catalog.generatedAt,
  photos: Object.fromEntries(photosUsed.map((u) => [u, photoEntry(photoByUrl.get(u))])),
  legacy: Object.fromEntries(Object.values(LEG).map((a) => [a.src, legacyEntry(a)]).sort((a, b) => a[0].localeCompare(b[0]))),
  cities,
  guides: Object.fromEntries(Object.values(guides).map((g) => [g.userId, g.url])),
  // profile photos: by user id, by display name (the web usually only knows the name) and a pool for everyone else
  people: {
    byId: Object.fromEntries(Object.values(people).map((p) => [p.userId, p.url])),
    byName: Object.fromEntries(Object.values(people).filter((p) => p.name).map((p) => [p.name, p.url])),
    pool: portraits.map((p) => p.src),
  },
  hero,
  charter,
  archive,
  embeds: catalog.legacy.embeds.map((e) => ({ provider: e.provider ?? 'youtube', id: e.id, title: e.title, date: e.date ?? null, dateText: e.dateText ?? null, thumb: e.thumbnail?.src ?? null, page: '/about/about-ceo' })),
  // convenience indexes (the API returns only media ids for travel products)
  products: Object.fromEntries([...Object.values(products).map((p) => [p.productId, p.urls]), ...legacyProducts.map((p) => [p.productId, p.media])]),
  stays: Object.fromEntries(Object.entries(stays).map(([slug, s]) => [slug, s.photos.map((x) => x.url)])),
  pages: Object.fromEntries(cms.map((c) => [c.route, { type: c.type, slug: c.slug, title: c.title, heroUrl: c.heroUrl }])),
  // named pools for generic fallbacks (web lib/media.ts photoPool(name)) — every url is in photos/legacy above
  pools: {
    stay: Object.values(stays).map((s) => s.photos[0].url),
    guide: Object.values(guides).map((g) => g.url),
    travel: uniq(Object.values(products).flatMap((p) => p.urls)),
    destination: Object.values(destinations).map((d) => d.coverUrl),
    exchange: uniq([...(catalog.usagePlan.exchange ?? []).filter((s) => LEG[s] && isVisual(s)).map(legacyUrl)]),
    legacy: uniq((catalog.usagePlan['discover:legacy'] ?? []).filter((s) => LEG[s]).map(legacyUrl)),
    charter,
    hero,
  },
};
for (const u of [...hero, ...charter, ...Object.values(cities), ...Object.values(mediaMap.guides), ...Object.values(mediaMap.people.byId), ...mediaMap.people.pool,
  ...Object.values(mediaMap.pools).flat(), ...Object.values(mediaMap.products).flat()]) {
  if (!mediaMap.photos[u] && !mediaMap.legacy[u]) fail(`media-map references unknown url ${u}`);
}

// ───────────────────────────────────────────────────────────── write / check
const outA = `${JSON.stringify(assignments, null, 2)}\n`;
const outM = `${JSON.stringify(mediaMap)}\n`;
if (CHECK) {
  const same = (f, s) => existsSync(f) && readFileSync(f, 'utf8') === s;
  const stale = [[OUT_ASSIGN, outA], [OUT_MAP, outM]].filter(([f, s]) => !same(f, s)).map(([f]) => path.relative(ROOT, f));
  if (stale.length) fail(`out of date: ${stale.join(', ')} — run node scripts/legacy/assign.mjs`);
  console.log('assign: outputs are current');
} else {
  mkdirSync(path.dirname(OUT_MAP), { recursive: true });
  writeFileSync(OUT_ASSIGN, outA);
  writeFileSync(OUT_MAP, outM);
  console.log(`assign: wrote ${path.relative(ROOT, OUT_ASSIGN)} (${(outA.length / 1024).toFixed(0)} KB) and ${path.relative(ROOT, OUT_MAP)} (${(outM.length / 1024).toFixed(0)} KB)`);
}
console.log(
  `assign: ${coverage.stays} stays × 5 photos (${coverage.distinctStayCovers} distinct covers), ${coverage.guides} guides, ` +
    `${coverage.people} profile photos of ${coverage.portraits} portraits, ${coverage.products}+${coverage.legacyProducts} products, ` +
    `${coverage.cmsEntries} CMS entries, ${coverage.redirects} redirects; legacy ${coverage.contextual}/${coverage.legacyMediaTotal} placed in context, ` +
    `${coverage.archived}/${coverage.legacyMediaTotal} in the archive; ${coverage.photosUsed} licensed photos used, all credited`,
);
