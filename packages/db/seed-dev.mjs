#!/usr/bin/env node
// Deterministic DEV/STAGING demo data. Refuses to run in production.
// Approved compliance/finance rules created here are placeholders for local testing only — real rules
// require legal/tax approval (Release Gate G9) and must be entered through the admin approval workflow.
//
// What this seeds (every id is a deterministic uid(...) and every insert is idempotent — a re-run adds nothing):
//  - the 9 login personas (emails/password unchanged) plus demo hosts, travelers and guides
//  - 24 published stays: Seoul (6 gu), Busan, Jeju, Gangneung, Sokcho, Gyeongju, Jeonju, Yeosu
//  - 8 published guides, 8 travel products with departures, legacy WONT Travel Club CMS content
//  - transactions with full state_transitions history: completed stays → reviews, upcoming confirmed stays,
//    Home Exchanges (COUNTERED / CONFIRMED / REVIEWED), guide bookings, travel orders; conversations,
//    notifications, favorites, an itinerary; reputation_scores are recomputed from the reviews.
//  - then (when data/media/assignments.json exists) packages/db/seed-media.mjs: licensed real photos for every stay,
//    guide, product and CMS cover, and the migrated wontc.co.kr pages / media / redirects (see scripts/legacy/assign.mjs)
// DEV seed rule: NO payments / refunds / ledger rows are written. Money only moves through the real payment
// path (PAY-01 → FIN-01), so the CONFIRMED / PAID demo records below have no payment object and settle nothing.
// Dates are relative to the first run ("today" in Asia/Seoul) and existing rows are never rewritten, except
// seed-owned listing copy/media that was never edited, plus travel departures and guide availability, which
// roll forward by calendar date (keyed by date) so the catalogue keeps upcoming dates on later runs.
import pg from 'pg';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev refuses to run with NODE_ENV=production');
  process.exit(1);
}
const url = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool';
const db = new pg.Client({ connectionString: url });
await db.connect();

const PASSWORD = process.env.SEED_PASSWORD ?? 'Jetpool!2026dev';
function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
// deterministic uuid from a name (v4-shaped)
const uid = (name) => {
  const h = createHash('sha256').update(`jetpool-seed:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const pwHash = hashPassword(PASSWORD);

// ------------------------------------------------------------------------------------------------ helpers
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** Same canonical JSON as apps/api/src/platform/crypto.ts (exchange agreement terms hash). */
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};
const codeFor = (key, len = 10) => sha256(`jetpool-seed-code:${key}`).slice(0, len).toUpperCase();
const applyBps = (amount, bps) => Math.floor((amount * bps + 5000) / 10000); // == platform/money.ts
const J = (v) => JSON.stringify(v);
const DAY_MS = 86_400_000;
const TODAY = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // calendar day in Asia/Seoul
const day = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Local Seoul wall-clock time n days from today, as a timestamptz literal. */
const at = (n, hhmm = '12:00') => `${day(n)}T${hhmm}:00+09:00`;
const plusMin = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const nightsOf = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const weekdayOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const run = (text, params = []) => db.query(text, params);
const one = async (text, params = []) => (await db.query(text, params)).rows[0] ?? null;
const counts = {};
const bump = (k, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
const skipped = [];
/** INSERT ... ON CONFLICT DO NOTHING; counts newly inserted rows under `label`. */
async function ins(label, text, params) {
  const r = await db.query(text, params);
  if (r.rowCount) bump(label, r.rowCount);
  return r.rowCount > 0;
}

/** Append FSM history (state_transitions is append-only): each step is written once (guarded by NOT EXISTS). */
async function history(aggregateType, aggregateId, steps) {
  for (const [from, to, when, actorId, actorType, reason, metadata] of steps) {
    const r = await run(
      `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_id, actor_type, reason, correlation_id, metadata, created_at)
       SELECT $1::text, $2::uuid, $3::text, $4::text, $5::uuid, $6::text, $7::text, $8::text, $9::jsonb, $10::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM state_transitions WHERE aggregate_type = $1::text AND aggregate_id = $2::uuid
                            AND to_state = $4::text AND from_state IS NOT DISTINCT FROM $3::text)`,
      [aggregateType, aggregateId, from, to, actorId ?? null, actorType, reason ?? null, `seed-dev:${aggregateType}:${aggregateId.slice(0, 8)}`,
        J({ seed: true, ...(metadata ?? {}) }), when],
    );
    if (r.rowCount) bump('state_transitions');
  }
}

/** True when no ACTIVE inventory block (other than `own`) overlaps [start, end) — mirrors the exclusion constraint. */
async function rangeFree(propertyId, start, end, own = []) {
  return !(await one(
    `SELECT 1 FROM inventory_blocks WHERE property_id = $1 AND state = 'ACTIVE' AND stay_range && daterange($2::date, $3::date, '[)')
        AND NOT (id = ANY($4::uuid[])) LIMIT 1`,
    [propertyId, start, end, own],
  ));
}
async function block(id, propertyId, start, end, blockType, sourceType, sourceId, createdBy, note, createdAt) {
  await ins('inventory_blocks',
    `INSERT INTO inventory_blocks(id, property_id, stay_range, block_type, source_type, source_id, state, created_by, note, created_at)
     VALUES ($1,$2,daterange($3::date,$4::date,'[)'),$5,$6,$7,'ACTIVE',$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    [id, propertyId, start, end, blockType, sourceType, sourceId, createdBy, note, createdAt]);
}

// Listing photos are the web app's own generative postcard illustrations (apps/web/public/art/postcards — abstract
// skylines, seas and hills, so any of them can stand in for a Korean listing). Only files that exist are referenced.
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/public');
const HAS_PUBLIC = existsSync(PUBLIC_DIR);
const publicFile = (u) => path.join(PUBLIC_DIR, ...u.split('/').filter(Boolean));
const exists = (u) => !HAS_PUBLIC || existsSync(publicFile(u));
const fileSize = (u) => {
  try {
    return statSync(publicFile(u)).size || 1024;
  } catch {
    return 1024;
  }
};
/** Postcard art list for a listing: wanted names that exist, padded to `min` with generic art, never empty. */
function artUrls(names, min = 3) {
  const pool = [...new Set([...names, 'coast', 'city', 'mountain', 'seoul', 'jeju', 'busan'])].map((n) => `/art/postcards/${n}.svg`);
  const ok = pool.filter(exists);
  const wanted = names.map((n) => `/art/postcards/${n}.svg`).filter(exists);
  const out = [...wanted];
  for (const u of ok) if (out.length < Math.max(min, wanted.length) && !out.includes(u)) out.push(u);
  if (out.length) return out;
  const placeholders = [1, 2, 3, 4, 5, 6].map((i) => `/placeholder/${i}.svg`).filter(exists);
  return placeholders.length ? placeholders.slice(0, min) : names.map((n) => `/art/postcards/${n}.svg`);
}
const CAPTIONS = ['대표 사진', '거실과 주방', '침실', '동네 풍경', '테라스·마당', '욕실'];
// Real photos: when data/media/assignments.json exists (scripts/legacy/assign.mjs), listings get licensed real photos
// from packages/db/seed-media.mjs (run at the end of this seed) instead of the postcard art above.
const MEDIA_ASSIGNMENTS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/media/assignments.json');
let MEDIA_ASSIGNED_STAYS = new Set();
try {
  if (existsSync(MEDIA_ASSIGNMENTS_FILE)) MEDIA_ASSIGNED_STAYS = new Set(Object.keys(JSON.parse(readFileSync(MEDIA_ASSIGNMENTS_FILE, 'utf8')).stays ?? {}));
} catch (e) {
  console.warn(`seed-dev: ignoring unreadable ${MEDIA_ASSIGNMENTS_FILE}: ${e.message}`);
}

async function user(key, email, name, roles = [], verified = true, opts = {}) {
  const id = uid(`user:${key}`);
  await db.query(
    `INSERT INTO users(id, email, password_hash, display_name, email_verified_at, identity_verified_at, locale, created_at)
     VALUES ($1,$2,$3,$4, coalesce($7::timestamptz, now()), CASE WHEN $5 THEN coalesce($7::timestamptz, now()) END, $6, coalesce($7::timestamptz, now()))
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [id, email, pwHash, name, verified, opts.locale ?? 'ko-KR', opts.since ?? null],
  );
  await db.query(`INSERT INTO user_profiles(user_id, preferred_name, languages) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, name, opts.languages ?? ['ko', 'en']]);
  if (opts.bio || opts.country) {
    // enrichment only fills empty fields (never overwrites what a user edited)
    await db.query(`UPDATE user_profiles SET bio = coalesce(bio, $2), country = coalesce(country, $3)
                     WHERE user_id = $1 AND ((bio IS NULL AND $2::text IS NOT NULL) OR (country IS NULL AND $3::char(2) IS NOT NULL))`,
      [id, opts.bio ?? null, opts.country ?? null]);
  }
  await db.query(`INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  for (const r of roles) await db.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, r]);
  return id;
}

// ------------------------------------------------------------------------------------------------ data
// [key, email, display name, opts] — demo travelers who write the reviews (all share the DEV password)
const TRAVELERS = [
  ['traveler-seoyeon', 'seoyeon.lee@jetpool.dev', '이서연', { bio: '사진 찍으며 천천히 걷는 여행을 좋아해요.', country: 'KR', since: at(-420) }],
  ['traveler-junho', 'junho.park@jetpool.dev', '박준호', { bio: '아이 둘과 함께 전국 한달살기 중인 아빠 여행자.', country: 'KR', since: at(-380) }],
  ['traveler-emma', 'emma.wilson@jetpool.dev', 'Emma Wilson', { bio: 'Remote product designer from Portland, slow-travelling Korea.', country: 'US', locale: 'en-US', languages: ['en'], since: at(-300) }],
  ['traveler-minji', 'minji.choi@jetpool.dev', '최민지', { bio: '프리랜서 번역가. 일 년에 두 번은 다른 도시에서 한 달씩 살아요.', country: 'KR', since: at(-520) }],
  ['traveler-takeshi', 'takeshi.sato@jetpool.dev', 'Takeshi Sato', { bio: 'Osaka-based architect who loves hanok and coffee.', country: 'JP', locale: 'en-US', languages: ['ja', 'en', 'ko'], since: at(-260) }],
  ['traveler-haneul', 'haneul.jung@jetpool.dev', '정하늘', { bio: '바다 근처 숙소만 찾아다니는 워케이션러.', country: 'KR', since: at(-200) }],
  ['traveler-lucas', 'lucas.martin@jetpool.dev', 'Lucas Martin', { bio: 'French photographer on a year-long trip around East Asia.', country: 'FR', locale: 'en-US', languages: ['fr', 'en'], since: at(-240) }],
  ['traveler-jiwoo', 'jiwoo.han@jetpool.dev', '한지우', { bio: '혼자 떠나는 주말 여행 기록가.', country: 'KR', since: at(-330) }],
];

// [key, email, display name, about, response rate, preferred exchange destinations, exchange home description, since]
const NEW_HOSTS = [
  ['host-gangwon', 'host.gangwon@jetpool.dev', '강원 바다숲 스테이', '강릉·속초에서 바다와 산을 모두 누릴 수 있는 숙소 네 곳을 운영합니다. 워케이션 장기 숙박을 특히 환영해요.', 95.5,
    ['Jeju', 'Seoul'], '강릉 안목해변 앞 오션뷰 투룸을 맞교환으로 열어 두었습니다. 커피 드립 세트와 넓은 책상이 있어요.', at(-640)],
  ['host-hanok', 'host.hanok@jetpool.dev', '한옥스테이 소담', '서촌·경주·전주의 오래된 한옥을 고쳐 운영하는 한옥 전문 호스트입니다. 전통 다도와 한지 공예 체험도 안내해 드려요.', 99.0,
    ['Busan', 'Jeju'], '경주 보문호수 앞 레이크뷰 빌라를 2주 이상 맞교환으로 열어 두었습니다. 가족 여행에 좋아요.', at(-900)],
  ['host-namhae', 'host.namhae@jetpool.dev', '남해안 오션스테이', '부산 광안리·기장·영도와 여수 돌산까지, 남해안 바다 숙소를 운영합니다. 현지 맛집 지도를 꼭 챙겨 드려요.', 96.0,
    ['Seoul', 'Gangneung'], '광안리 해변 앞 레지던스를 맞교환으로 열어 두었습니다. 거실에서 광안대교 야경이 보여요.', at(-560)],
];

const AM_BASE = ['wifi', 'heating', 'smoke_alarm'];
// Listings. Legacy rows (first four slugs) keep their original ids, price, size and flags; their copy is upgraded only
// while it still is the original generated demo text.
const PROPERTIES = [
  { slug: 'seoul-hanok', legacy: true, host: 'hostA', title: '북촌 한옥 스테이', type: 'HANOK', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5826, lng: 126.9831,
    price: 180000, cleaning: 30000, rental: true, exchange: true, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 2, maxN: 60, policy: 'MODERATE', listedAgo: 240,
    area: '종로구 북촌 한옥마을', line1: '서울 종로구 계동길 일대', postal: '03058',
    summary: '경복궁과 창덕궁 사이, 100년 된 ㄷ자 한옥에서 보내는 서울의 느린 하루',
    description: '북촌 계동길 골목 안쪽에 자리한 1920년대 한옥을 현대식으로 고친 독채입니다. 마당을 둘러싼 대청마루와 온돌방 두 칸, 통창 너머로 기와지붕이 보이는 주방이 있어요. 경복궁·창덕궁·삼청동까지 걸어서 10분, 아침에는 골목 카페에서 커피 한 잔으로 하루를 시작해 보세요. 한달살기와 Home Exchange 모두 환영합니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'ondol', 'workspace', 'garden', 'fire_extinguisher', 'first_aid', 'self_checkin'],
    rules: { extra: '한옥 보존을 위해 실내 흡연과 향초 사용은 금지됩니다. 신발은 댓돌 위에 벗고 입실해 주세요.' }, art: ['seoul', 'gyeongju', 'mountain', 'city'], weekly: 1000, monthly: 2500 },
  { slug: 'seoul-apt', legacy: true, host: 'hostA', title: '성수 감성 아파트', type: 'APARTMENT', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5445, lng: 127.0557,
    price: 120000, cleaning: 30000, rental: true, exchange: false, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 2, maxN: 90, policy: 'MODERATE', listedAgo: 232,
    area: '성동구 성수동 카페거리', line1: '서울 성동구 성수이로 일대', postal: '04782',
    summary: '서울숲과 성수 카페거리를 걸어서 즐기는 채광 좋은 투룸 아파트',
    description: '성수역 3번 출구에서 도보 6분, 리모델링을 마친 15층 투룸 아파트입니다. 남향 거실에서 서울숲이 내려다보이고, 넓은 업무용 책상과 500Mbps 와이파이를 갖춰 워케이션에도 좋아요. 주변에 성수 카페거리, 뚝섬 한강공원, 대형 마트가 있어 한 달 살기에도 불편함이 없습니다.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'elevator', 'workspace', 'tv', 'fire_extinguisher', 'self_checkin'],
    rules: { extra: '공동주택이라 22시 이후에는 실내 소음에 주의해 주세요. 분리수거는 지하 1층 수거함을 이용합니다.' }, art: ['city', 'paris', 'seoul'], weekly: 1000, monthly: 2000 },
  { slug: 'jeju-villa', legacy: true, host: 'hostB', title: '애월 오션뷰 빌라', type: 'VILLA', city: 'Jeju', cityKo: '제주', region: 'KR-49', lat: 33.4628, lng: 126.3095,
    price: 260000, cleaning: 30000, rental: true, exchange: true, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 2, maxN: 60, policy: 'MODERATE', listedAgo: 228,
    area: '제주시 애월읍 해안도로', line1: '제주 제주시 애월읍 애월해안로 일대', postal: '63038',
    summary: '애월 해안도로 노을 명소, 잔디 정원과 바다 전망 테라스가 있는 독채 빌라',
    description: '애월 한담해변 산책로 위쪽에 자리한 2층 독채 빌라입니다. 잔디 정원과 바다 전망 테라스에서 매일 노을을 볼 수 있고, 곽지해수욕장과 카페거리까지 차로 5분이에요. 제주 한달살기를 위해 세탁건조기와 업무 공간, 넉넉한 수납을 갖췄습니다. 맞교환 제안도 언제든 환영합니다.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'parking', 'bbq', 'garden', 'workspace', 'tv', 'fire_extinguisher'],
    rules: { extra: '정원 바비큐는 21시까지 가능합니다. 렌터카 이용을 권장하며 전용 주차 2대가 가능해요.' }, art: ['jeju', 'coast', 'mountain', 'busan'], weekly: 1000, monthly: 2500 },
  { slug: 'busan-home', legacy: true, host: 'exchanger', title: '해운대 한달살기 집', type: 'APARTMENT', city: 'Busan', cityKo: '부산', region: 'KR-26', lat: 35.1587, lng: 129.1604,
    price: 90000, cleaning: 30000, rental: false, exchange: true, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 7, maxN: 60, policy: 'MODERATE', listedAgo: 220,
    area: '해운대구 해운대해수욕장 인근', line1: '부산 해운대구 구남로 일대', postal: '48094',
    summary: '해운대 바다까지 걸어서 5분, 한달살기 맞교환으로 내놓은 투룸 아파트',
    description: '해운대해수욕장과 동백섬 사이의 오래된 아파트를 직접 고쳐 사는 집입니다. 거실에서 바다가 살짝 보이고, 아침 해변 산책과 해운대 전통시장 장보기가 일상이 되는 곳이에요. 저희가 다른 도시에서 한 달을 지내는 동안 이 집을 맞교환으로 내어 드립니다. 베란다 화분 물 주기만 부탁드려요. (Home Exchange 전용)',
    amenities: ['kitchen', 'washer', 'aircon', 'elevator', 'workspace', 'tv'],
    rules: { extra: '맞교환 전용 숙소입니다. 반려식물 물 주기와 분리수거 요일(화·금)을 지켜 주세요.' }, art: ['busan', 'coast', 'city'] },

  // --- Seoul
  { slug: 'seoul-mangwon-house', host: 'hostA', title: '망원동 루프탑 단독주택', type: 'HOUSE', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5560, lng: 126.9015,
    price: 140000, cleaning: 35000, rental: true, exchange: true, guests: 5, bedrooms: 2, beds: 3, baths: 1.5, minN: 2, maxN: 90, policy: 'MODERATE', listedAgo: 150,
    area: '마포구 망원동 망원시장 인근', line1: '서울 마포구 망원로 일대', postal: '04007',
    summary: '망원시장과 한강공원 사이, 옥상 정원이 있는 2층 단독주택',
    description: '망원시장에서 3분, 망원한강공원까지 걸어서 10분 거리의 2층 단독주택입니다. 1층은 거실과 주방, 2층은 침실 두 개와 작은 서재로 나뉘어 있고, 옥상에는 텃밭과 바비큐 테이블이 있어요. 동네 빵집과 독립서점이 많은 망원동에서 서울 사람처럼 살아보세요. 바닷가 도시 회원의 맞교환 제안을 특히 환영합니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'bbq', 'garden', 'workspace', 'tv', 'first_aid'],
    rules: { pets: true, extra: '10kg 이하 반려견 1마리까지 함께할 수 있어요. 옥상 바비큐는 21시까지 이용해 주세요.' }, art: ['hanoi', 'seoul', 'coast'], weekly: 1000, monthly: 3000 },
  { slug: 'seoul-yeonnam-studio', host: 'hostA', title: '연남동 경의선숲길 스튜디오', type: 'STUDIO', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5622, lng: 126.9246,
    price: 75000, cleaning: 20000, rental: true, exchange: false, guests: 2, bedrooms: 0, beds: 1, baths: 1, minN: 1, maxN: 60, policy: 'FLEXIBLE', instant: true, listedAgo: 132,
    area: '마포구 연남동 경의선숲길', line1: '서울 마포구 성미산로 일대', postal: '03983',
    summary: '연트럴파크 산책로 바로 앞, 혼자 또는 둘이 머물기 좋은 아늑한 스튜디오',
    description: '경의선숲길(연트럴파크)과 맞닿은 신축 빌라 3층 스튜디오입니다. 퀸 침대와 작은 주방, 드럼세탁기를 갖췄고 홍대입구역 3번 출구까지 도보 7분이에요. 공항철도로 인천공항까지 한 번에 갈 수 있어 출장자와 장기 체류 여행자에게 인기가 많습니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'workspace', 'self_checkin', 'tv'],
    rules: { extra: '셀프 체크인 비밀번호는 체크인 당일 오전에 메시지로 보내드립니다.' }, art: ['tokyo', 'city', 'mountain'], weekly: 800 },
  { slug: 'seoul-hannam-villa', host: 'hostA', title: '한남동 프라이빗 테라스 빌라', type: 'VILLA', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5347, lng: 127.0026,
    price: 420000, cleaning: 60000, rental: true, exchange: false, guests: 6, bedrooms: 3, beds: 3, baths: 2.5, minN: 2, maxN: 30, policy: 'STRICT', listedAgo: 96,
    area: '용산구 한남동 이태원로 인근', line1: '서울 용산구 한남대로 일대', postal: '04400',
    summary: '남산과 한강이 동시에 보이는 테라스, 가족 여행에 좋은 3베드룸 빌라',
    description: '한남동 언덕 위 조용한 주택가에 있는 3층 빌라 전체를 사용합니다. 넓은 테라스에서 남산타워와 한강 야경이 보이고, 각 침실에 전용 욕실이 있어 가족·친구 여행에 편안해요. 리움미술관과 한남동 편집숍 거리, 이태원까지 걸어서 이동할 수 있으며 전용 주차 2대가 가능합니다.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'parking', 'tv', 'workspace', 'bbq', 'crib', 'fire_extinguisher', 'first_aid'],
    rules: { extra: '파티·행사는 불가하며 테라스는 22시까지 이용해 주세요. 유아 침대는 요청 시 준비해 드립니다.' }, art: ['osaka', 'seoul', 'mountain', 'city'] },
  { slug: 'seoul-jamsil-apt', host: 'hostA', title: '잠실 석촌호수 뷰 아파트', type: 'APARTMENT', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5096, lng: 127.1001,
    price: null, cleaning: 0, rental: false, exchange: true, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 7, maxN: 60, policy: 'MODERATE', listedAgo: 88,
    area: '송파구 잠실동 석촌호수 인근', line1: '서울 송파구 석촌호수로 일대', postal: '05554',
    summary: '석촌호수 산책길이 내려다보이는 맞교환 전용 가족형 아파트',
    description: '석촌호수 동호 산책로 바로 앞 25층 아파트로, 거실 창으로 호수와 롯데월드타워가 보입니다. 아이 방에는 이층 침대와 장난감이 있고, 단지 안에 놀이터와 편의점이 있어 가족 단위 맞교환에 잘 맞아요. 저희 가족이 다른 도시에서 지내는 동안 이 집에서 서울 생활을 누려 보세요. (Home Exchange 전용)',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'elevator', 'parking', 'tv', 'crib'],
    rules: { extra: '맞교환 전용 숙소입니다. 단지 주차는 1대까지 등록해 드려요.' }, art: ['paris', 'city', 'coast'] },
  { slug: 'seoul-seochon-hanok', host: 'host-hanok', title: '서촌 누하동 한옥 독채', type: 'HANOK', city: 'Seoul', cityKo: '서울', region: 'KR-11', lat: 37.5787, lng: 126.9688,
    price: 230000, cleaning: 40000, rental: true, exchange: false, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 2, maxN: 30, policy: 'MODERATE', listedAgo: 120,
    area: '종로구 서촌 누하동', line1: '서울 종로구 필운대로 일대', postal: '03036',
    summary: '인왕산 자락 골목 끝, 작은 마당과 툇마루가 있는 서촌 한옥 독채',
    description: '경복궁 서쪽 서촌 골목 끝에 숨어 있는 한옥 독채입니다. 툇마루에 앉으면 인왕산 능선이 보이고, 아침에는 통인시장과 수성동 계곡으로 산책을 나서기 좋아요. 편백 욕조와 온돌 침실, 전통 다기 세트를 준비해 두었습니다. 경복궁역 2번 출구에서 도보 8분.',
    amenities: ['kitchen', 'washer', 'aircon', 'ondol', 'garden', 'fire_extinguisher', 'first_aid'],
    rules: { extra: '한옥 보존을 위해 실내 흡연·향초 사용은 금지됩니다. 편백 욕조는 사용 후 물을 빼 주세요.' }, art: ['mountain', 'gyeongju', 'seoul'], weekly: 1000 },

  // --- Busan
  { slug: 'busan-gwangalli-ocean', host: 'host-namhae', title: '광안리 오션프론트 레지던스', type: 'APARTMENT', city: 'Busan', cityKo: '부산', region: 'KR-26', lat: 35.1532, lng: 129.1186,
    price: 150000, cleaning: 30000, rental: true, exchange: true, guests: 4, bedrooms: 1, beds: 2, baths: 1, minN: 1, maxN: 60, policy: 'MODERATE', instant: true, listedAgo: 140,
    area: '수영구 광안리해수욕장 앞', line1: '부산 수영구 광안해변로 일대', postal: '48303',
    summary: '광안대교 야경이 침대에서 보이는 광안리 해변 앞 레지던스',
    description: '광안리해수욕장 해변도로에 접한 레지던스 18층, 통창 너머로 광안대교와 바다가 한눈에 들어옵니다. 주말 드론쇼를 거실에서 편하게 볼 수 있고, 1층에는 브런치 카페와 편의점이 있어요. 지하철 광안역까지 도보 8분, 해운대와 서면도 20분이면 닿습니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'elevator', 'parking', 'tv', 'self_checkin'],
    rules: { extra: '건물 규정상 발코니 흡연은 금지입니다. 주차는 1대 무료이며 사전 등록이 필요해요.' }, art: ['osaka', 'busan', 'coast'], weekly: 800 },
  { slug: 'busan-yeongdo-guesthouse', host: 'host-namhae', title: '영도 흰여울마을 게스트하우스', type: 'GUESTHOUSE', room: 'PRIVATE_ROOM', city: 'Busan', cityKo: '부산', region: 'KR-26', lat: 35.0784, lng: 129.0450,
    price: 65000, cleaning: 10000, rental: true, exchange: false, guests: 2, bedrooms: 1, beds: 1, baths: 1, minN: 1, maxN: 30, policy: 'FLEXIBLE', listedAgo: 70,
    area: '영도구 흰여울문화마을', line1: '부산 영도구 절영로 일대', postal: '49041',
    summary: '절벽 위 흰여울마을, 바다를 마주한 2인 개인실과 공용 라운지',
    description: '흰여울문화마을 절벽 위 게스트하우스의 개인실입니다. 방 창문 앞으로 정박한 배들과 남항대교가 펼쳐지고, 공용 라운지에서 다른 여행자들과 차를 나눌 수 있어요. 해안 산책로와 절영해안길이 바로 아래에 있습니다.',
    amenities: ['aircon', 'washer', 'first_aid', 'self_checkin'],
    rules: { extra: '공용 라운지는 23시 이후 조용히 이용해 주세요. 개인실은 2인까지 숙박할 수 있습니다.' }, art: ['coast', 'busan', 'mountain'] },
  { slug: 'busan-gijang-villa', host: 'host-namhae', title: '기장 오션 풀빌라', type: 'VILLA', city: 'Busan', cityKo: '부산', region: 'KR-26', lat: 35.2448, lng: 129.2222,
    price: 320000, cleaning: 50000, rental: true, exchange: false, guests: 6, bedrooms: 3, beds: 4, baths: 2, minN: 2, maxN: 30, policy: 'STRICT', listedAgo: 110,
    area: '기장군 기장읍 해안로', line1: '부산 기장군 기장읍 기장해안로 일대', postal: '46083',
    summary: '해동용궁사 근처 바다 앞 개인 수영장 풀빌라, 가족·친구 여행 추천',
    description: '기장 해안도로 위 단독 풀빌라로, 사계절 온수 개인 수영장과 바다를 향한 바비큐 데크가 있습니다. 해동용궁사와 오시리아 관광단지까지 차로 10분 이내이며, 동해선 기장역 픽업이 가능해요. 식기세척기를 갖춘 주방에서 기장 미역과 장어로 저녁을 차려 보세요.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'parking', 'pool', 'bbq', 'tv', 'crib', 'fire_extinguisher', 'first_aid'],
    rules: { extra: '수영장은 09:00–22:00에 이용할 수 있으며 어린이는 보호자와 함께해 주세요.' }, art: ['bali', 'coast', 'busan'] },

  // --- Jeju
  { slug: 'jeju-hallim-stone-house', host: 'hostB', title: '한림 돌담 독채 (협재 해변 5분)', type: 'HOUSE', city: 'Jeju', cityKo: '제주', region: 'KR-49', lat: 33.3940, lng: 126.2397,
    price: 190000, cleaning: 40000, rental: true, exchange: true, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 2, maxN: 90, policy: 'MODERATE', listedAgo: 205,
    area: '제주시 한림읍 협재리', line1: '제주 제주시 한림읍 협재리 일대', postal: '63017',
    summary: '현무암 돌담과 귤나무 마당, 협재 해변까지 걸어서 가는 제주 전통 돌집',
    description: '제주 전통 돌집 두 채를 이어 고친 독채로, 안거리는 거실과 주방, 밖거리는 침실로 쓰입니다. 귤나무가 있는 마당에서 비양도가 보이고, 협재·금능 해변까지 걸어서 5분이에요. 일주일 이상 머무시면 10%, 한 달은 25% 할인돼요.',
    amenities: ['kitchen', 'washer', 'aircon', 'ondol', 'parking', 'garden', 'bbq', 'first_aid'],
    rules: { extra: '돌담 옆 전용 주차 공간을 이용해 주세요. 마당 귤은 열린 만큼 자유롭게 드셔도 됩니다.' }, art: ['chiangmai', 'jeju', 'coast'], weekly: 1000, monthly: 2500 },
  { slug: 'jeju-seogwipo-apt', host: 'hostB', title: '서귀포 올레시장 한달살기 아파트', type: 'APARTMENT', city: 'Jeju', cityKo: '제주', region: 'KR-49', lat: 33.2497, lng: 126.5654,
    price: 110000, cleaning: 30000, rental: true, exchange: false, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 7, maxN: 90, policy: 'MODERATE', listedAgo: 180,
    area: '서귀포시 서귀동 매일올레시장 인근', line1: '제주 서귀포시 중정로 일대', postal: '63596',
    summary: '올레 6코스와 매일올레시장 사이, 한라산과 바다가 보이는 한달살기 아파트',
    description: '서귀포 매일올레시장에서 걸어서 5분, 남쪽 바다와 한라산이 모두 보이는 아파트입니다. 이중섭거리와 천지연폭포, 올레 6·7코스가 가까워 걷기 여행에 좋아요. 4주 이상 머무는 한달살기 손님을 위해 주방 살림과 다리미, 책상, 자전거 2대를 준비해 두었습니다.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'elevator', 'parking', 'workspace', 'tv'],
    rules: { extra: '최소 7박부터 예약할 수 있습니다. 자전거는 사용 후 1층 거치대에 잠가 주세요.' }, art: ['mountain', 'jeju', 'coast'], weekly: 1000, monthly: 3000 },
  { slug: 'jeju-gujwa-studio', host: 'hostB', title: '세화 바다 앞 미니 스튜디오', type: 'STUDIO', city: 'Jeju', cityKo: '제주', region: 'KR-49', lat: 33.5245, lng: 126.8580,
    price: 85000, cleaning: 20000, rental: true, exchange: false, guests: 2, bedrooms: 0, beds: 1, baths: 1, minN: 1, maxN: 30, policy: 'FLEXIBLE', instant: true, listedAgo: 64,
    area: '제주시 구좌읍 세화리', line1: '제주 제주시 구좌읍 세화리 일대', postal: '63359',
    summary: '세화 해변 앞 에메랄드빛 바다를 창가에서 보는 2인 스튜디오',
    description: '구좌읍 세화 해변 앞 돌담길에 있는 작은 스튜디오입니다. 창가 테이블에 앉으면 에메랄드빛 바다가 보이고, 세화 벨롱장과 해녀박물관, 월정리 카페거리가 가까워요. 혼자 또는 둘이서 조용히 쉬어가기 좋은 공간으로, 셀프 체크인이라 늦은 도착도 편합니다.',
    amenities: ['kitchen', 'aircon', 'self_checkin', 'workspace'],
    rules: { extra: '해변 모래는 현관 샤워기로 털고 들어와 주세요.' }, art: ['bali', 'jeju', 'coast'] },

  // --- Gangneung / Sokcho (KR-42)
  { slug: 'gangneung-anmok-apt', host: 'host-gangwon', title: '안목 커피거리 오션뷰 아파트', type: 'APARTMENT', city: 'Gangneung', cityKo: '강릉', region: 'KR-42', lat: 37.7720, lng: 128.9478,
    price: 130000, cleaning: 30000, rental: true, exchange: true, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 2, maxN: 60, policy: 'MODERATE', listedAgo: 160,
    area: '견소동 안목해변', line1: '강원 강릉시 창해로 일대', postal: '25631',
    summary: '커피 향 가득한 안목해변 앞, 강릉 워케이션에 딱 맞는 오션뷰 투룸',
    description: '강릉 안목 커피거리 해변 앞 아파트 12층으로, 거실 책상에서 바다를 보며 일할 수 있습니다. KTX 강릉역에서 택시로 10분, 송정 솔숲 산책로와 남항진 해변이 가까워요. 원두 그라인더와 드립 세트를 비치해 두었으니 아침마다 커피 한 잔을 내려 보세요.',
    amenities: ['kitchen', 'washer', 'aircon', 'elevator', 'parking', 'workspace', 'tv'],
    rules: { extra: '주차는 1대 무료입니다. 원두는 마음껏 드시고 다 쓰시면 메시지 주세요!' }, art: ['gangneung', 'coast', 'city'], weekly: 1000, monthly: 2500 },
  { slug: 'gangneung-gyeongpo-house', host: 'host-gangwon', title: '경포 솔숲 단독주택', type: 'HOUSE', city: 'Gangneung', cityKo: '강릉', region: 'KR-42', lat: 37.7956, lng: 128.9087,
    price: 210000, cleaning: 40000, rental: true, exchange: false, guests: 6, bedrooms: 3, beds: 3, baths: 2, minN: 2, maxN: 30, policy: 'MODERATE', listedAgo: 125,
    area: '저동 경포호 인근', line1: '강원 강릉시 경포로 일대', postal: '25460',
    summary: '경포호 산책로와 솔숲 사이 정원 있는 단독주택, 가족 여행 추천',
    description: '경포호를 한 바퀴 도는 산책로와 소나무 숲 사이에 있는 2층 단독주택입니다. 넓은 잔디 정원과 바비큐 데크, 아이들을 위한 그네가 있고 경포해변과 오죽헌까지 차로 5분이에요. 침실 세 개와 욕실 두 개로 3대 가족 여행에도 넉넉합니다.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'parking', 'bbq', 'garden', 'tv', 'crib', 'fire_extinguisher', 'first_aid'],
    rules: { pets: true, extra: '반려견은 2마리까지 가능하며 실내 침대 위는 피해 주세요.' }, art: ['chiangmai', 'gangneung', 'mountain'] },
  { slug: 'sokcho-seorak-cabin', host: 'host-gangwon', title: '설악산 뷰 우드 캐빈', type: 'HOUSE', city: 'Sokcho', cityKo: '속초', region: 'KR-42', lat: 38.1709, lng: 128.5290,
    price: 160000, cleaning: 30000, rental: true, exchange: false, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 1, maxN: 30, policy: 'MODERATE', listedAgo: 100,
    area: '노학동 설악산 입구', line1: '강원 속초시 설악산로 일대', postal: '24803',
    summary: '창밖으로 울산바위가 보이는 설악산 자락의 통나무 캐빈',
    description: '설악산 소공원까지 차로 7분, 울산바위가 정면으로 보이는 원목 캐빈입니다. 온돌과 전기 난로를 갖춰 쌀쌀한 날에도 따뜻하고, 데크에서 별을 보며 바비큐를 즐길 수 있어요. 속초중앙시장과 영금정, 대포항까지는 차로 15분 거리입니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'ondol', 'parking', 'bbq', 'tv', 'fire_extinguisher', 'first_aid'],
    rules: { extra: '산불 예방을 위해 데크 외 장소에서의 불 사용은 금지됩니다.' }, art: ['mountain', 'gangneung', 'chiangmai'] },
  { slug: 'sokcho-harbor-studio', host: 'host-gangwon', title: '동명항 등대 앞 스튜디오', type: 'STUDIO', city: 'Sokcho', cityKo: '속초', region: 'KR-42', lat: 38.2120, lng: 128.6000,
    price: 70000, cleaning: 15000, rental: true, exchange: false, guests: 2, bedrooms: 0, beds: 1, baths: 1, minN: 1, maxN: 30, policy: 'FLEXIBLE', instant: true, listedAgo: 48,
    area: '동명동 영금정 인근', line1: '강원 속초시 영금정로 일대', postal: '24838',
    summary: '영금정 일출과 동명항 등대가 보이는 혼행 맞춤 스튜디오',
    description: '속초 동명항과 영금정 정자가 내려다보이는 오피스텔형 스튜디오입니다. 새벽에 창문을 열면 바다 위로 해가 떠오르고, 걸어서 5분 거리에 속초관광수산시장과 아바이마을 갯배가 있어요. 혼자 떠나는 여행이나 짧은 출장에 알맞은 실속형 숙소입니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'elevator', 'self_checkin'],
    rules: { extra: '건물 전체 금연입니다. 체크인 비밀번호는 당일 오후에 보내드려요.' }, art: ['coast', 'gangneung', 'city'] },

  // --- Gyeongju (KR-47) / Jeonju (KR-45)
  { slug: 'gyeongju-hwangnam-hanok', host: 'host-hanok', title: '황리단길 한옥 스테이 월정', type: 'HANOK', city: 'Gyeongju', cityKo: '경주', region: 'KR-47', lat: 35.8370, lng: 129.2110,
    price: 200000, cleaning: 35000, rental: true, exchange: false, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 1, maxN: 30, policy: 'MODERATE', listedAgo: 175,
    area: '황남동 황리단길', line1: '경북 경주시 포석로 일대', postal: '38166',
    summary: '대릉원 돌담길과 황리단길 사이, 천년 고도의 밤을 즐기는 한옥 스테이',
    description: '대릉원 후문에서 걸어서 3분, 황리단길 골목 안쪽의 한옥 스테이입니다. 마당의 작은 연못과 툇마루, 편백 욕조가 있는 안채를 단독으로 사용하세요. 저녁에는 첨성대와 동궁과 월지 야경까지 산책할 수 있고, 아침에는 경주빵과 차를 준비해 드립니다.',
    amenities: ['kitchen', 'aircon', 'ondol', 'garden', 'fire_extinguisher', 'first_aid', 'self_checkin'],
    rules: { extra: '조식(경주빵과 차)은 08:00–09:30에 툇마루로 준비해 드립니다.' }, art: ['gyeongju', 'mountain', 'lisbon'] },
  { slug: 'gyeongju-bomun-villa', host: 'host-hanok', title: '보문호수 레이크뷰 빌라', type: 'VILLA', city: 'Gyeongju', cityKo: '경주', region: 'KR-47', lat: 35.8423, lng: 129.2840,
    price: 280000, cleaning: 45000, rental: true, exchange: true, guests: 6, bedrooms: 3, beds: 3, baths: 2, minN: 2, maxN: 60, policy: 'STRICT', listedAgo: 200,
    area: '신평동 보문관광단지', line1: '경북 경주시 보문로 일대', postal: '38117',
    summary: '보문호수 벚꽃길 앞, 넓은 거실과 테라스가 있는 레이크뷰 빌라',
    description: '보문호수 순환 산책로 바로 앞 빌라로, 거실과 테라스에서 호수와 벚꽃길이 보입니다. 경주월드와 워터파크, 엑스포공원까지 차로 5분이라 아이와 함께하는 여행에 좋아요. 맞교환 회원께는 계절 상관없이 2주 이상 교환을 열어 두었습니다.',
    amenities: ['kitchen', 'washer', 'dryer', 'aircon', 'parking', 'bbq', 'tv', 'crib', 'fire_extinguisher'],
    rules: { extra: '테라스 바비큐는 21시까지 가능합니다. 호숫가 산책로에서는 자전거를 끌고 다녀 주세요.' }, art: ['lisbon', 'gyeongju', 'coast'], weekly: 1200 },
  { slug: 'jeonju-hanok-village', host: 'host-hanok', title: '전주 한옥마을 은행나무 한옥', type: 'HANOK', city: 'Jeonju', cityKo: '전주', region: 'KR-45', lat: 35.8150, lng: 127.1530,
    price: 150000, cleaning: 30000, rental: true, exchange: false, guests: 4, bedrooms: 2, beds: 2, baths: 1, minN: 1, maxN: 30, policy: 'MODERATE', listedAgo: 145,
    area: '완산구 교동 한옥마을', line1: '전북 전주시 완산구 은행로 일대', postal: '55041',
    summary: '600년 은행나무 골목 안, 전주 한옥마을 한가운데의 전통 한옥',
    description: '전주 한옥마을 은행로 골목 안쪽, 수백 년 된 은행나무가 보이는 한옥입니다. 경기전과 전동성당, 남부시장 야시장까지 모두 걸어서 10분 이내예요. 온돌방에서 한지 조명 아래 하룻밤을 보내고, 아침에는 콩나물국밥 맛집 지도를 들고 산책을 떠나 보세요.',
    amenities: ['kitchen', 'aircon', 'ondol', 'garden', 'fire_extinguisher'],
    rules: { extra: '한옥마을 특성상 낮에는 골목이 붐빌 수 있어요. 대문은 22시 이후 꼭 잠가 주세요.' }, art: ['bangkok', 'gyeongju', 'mountain'] },
  { slug: 'jeonju-gaeksa-room', host: 'host-hanok', title: '객사길 셰어하우스 개인실', type: 'ROOM', room: 'PRIVATE_ROOM', city: 'Jeonju', cityKo: '전주', region: 'KR-45', lat: 35.8189, lng: 127.1440,
    price: 60000, cleaning: 10000, rental: true, exchange: false, guests: 2, bedrooms: 1, beds: 1, baths: 1, minN: 1, maxN: 30, policy: 'FLEXIBLE', instant: true, listedAgo: 40,
    area: '완산구 고사동 객리단길', line1: '전북 전주시 완산구 객사길 일대', postal: '54998',
    summary: '객리단길 카페 골목 2층, 혼자 여행자를 위한 깔끔한 개인실',
    description: '전주 객사 앞 객리단길 카페 골목 2층의 셰어하우스 개인실입니다. 방에는 더블 침대와 책상, 개인 욕실이 있고 공용 주방에서 간단한 요리를 할 수 있어요. 전주역 버스가 바로 앞에 서고 한옥마을까지 걸어서 15분, 밤에도 안전하고 활기찬 동네입니다.',
    amenities: ['aircon', 'washer', 'workspace', 'self_checkin'],
    rules: { extra: '공용 주방은 23시까지 이용할 수 있으며 사용한 식기는 바로 정리해 주세요.' }, art: ['hanoi', 'city', 'gyeongju'] },

  // --- Yeosu (KR-46)
  { slug: 'yeosu-dolsan-ocean', host: 'host-namhae', title: '돌산 오션뷰 테라스 하우스', type: 'VILLA', city: 'Yeosu', cityKo: '여수', region: 'KR-46', lat: 34.7230, lng: 127.7420,
    price: 240000, cleaning: 40000, rental: true, exchange: false, guests: 5, bedrooms: 2, beds: 3, baths: 2, minN: 1, maxN: 30, policy: 'MODERATE', listedAgo: 84,
    area: '돌산읍 돌산대교 인근', line1: '전남 여수시 돌산읍 돌산로 일대', postal: '59724',
    summary: '여수 밤바다와 돌산대교 야경이 펼쳐지는 테라스 하우스',
    description: '돌산대교 건너 언덕 위 테라스 하우스로, 거실과 테라스에서 여수 밤바다와 돌산대교 조명이 한눈에 보입니다. 해상케이블카 돌산탑승장까지 차로 3분, 향일암 일출 명소와 낭만포차 거리도 가까워요. 게장백반과 갓김치 맛집 리스트를 웰컴 노트에 적어 두었습니다.',
    amenities: ['kitchen', 'washer', 'aircon', 'parking', 'bbq', 'tv', 'fire_extinguisher', 'first_aid'],
    rules: { extra: '테라스는 22시 이후 조용히 이용해 주세요. 주차는 2대까지 가능합니다.' }, art: ['coast', 'osaka', 'lisbon'] },
];

const PERMIT_TYPE = { HANOK: '한옥체험업', VILLA: '관광펜션업', HOUSE: '농어촌민박업', GUESTHOUSE: '외국인관광 도시민박업', ROOM: '외국인관광 도시민박업', APARTMENT: '외국인관광 도시민박업', STUDIO: '외국인관광 도시민박업' };

// Guides. The two legacy profiles keep their user ids/names; their copy is upgraded only while still the original text.
const GUIDES = [
  { key: 'guide-friend', legacy: true, legacyBio: '서울 골목 산책과 카페 투어를 좋아해요.', type: 'FRIEND', city: 'Seoul', lat: 37.57, lng: 126.98,
    headline: '서울 로컬 친구', bio: '성수동에서 일하는 UX 디자이너예요. 주말이면 카페 골목과 망원시장, 한강 산책로를 걷습니다. 관광지 대신 서울 친구가 사는 동네를 같이 걸어요!',
    languages: ['ko', 'en'], regions: ['seoul'], interests: ['food', 'cafe', 'walking'], specialties: ['성수 카페 골목', '망원시장', '한강 산책'], group: 4, hours: ['10:00', '20:00'] },
  { key: 'guide-pro', legacy: true, legacyBio: '궁궐과 역사 투어 전문 가이드.', type: 'PROFESSIONAL', city: 'Seoul', lat: 37.58, lng: 126.97, hourly: 50000,
    headline: '전문 역사 가이드', bio: '관광통역안내사 자격을 가진 15년 차 역사 가이드입니다. 경복궁·창덕궁 후원부터 경주 불국사까지, 한국어·영어·일본어로 깊이 있는 해설을 드려요.',
    languages: ['ko', 'en', 'ja'], regions: ['seoul', 'gyeongju'], interests: ['history', 'palace'], specialties: ['경복궁', '창덕궁 후원', '불국사'], group: 12, hours: ['09:00', '18:00'],
    quals: ['BUSINESS_REGISTRATION', 'GUIDE_LICENSE'] },
  { key: 'guide-busan', email: 'guide.busan@jetpool.dev', name: '해설봉사 현우', type: 'VOLUNTEER', city: 'Busan', lat: 35.1028, lng: 129.0347,
    headline: '부산 원도심 자원봉사 해설사', bio: '은퇴 후 부산 중구에서 자원봉사 해설을 하고 있어요. 40계단, 보수동 책방골목, 감천문화마을까지 부산의 근현대사를 걸으며 들려드립니다.',
    languages: ['ko', 'en', 'zh'], regions: ['busan'], interests: ['history', 'market', 'walking'], specialties: ['40계단', '보수동 책방골목', '감천문화마을'], group: 10, hours: ['10:00', '17:00'], since: at(-500) },
  { key: 'guide-jeju', email: 'guide.jeju@jetpool.dev', name: '제주 친구 소라', type: 'FRIEND', city: 'Jeju', lat: 33.4996, lng: 126.5312,
    headline: '올레길 같이 걷는 제주 친구', bio: '제주 토박이 그래픽 디자이너예요. 주말마다 올레길을 걷고 동네 국숫집을 찾아다닙니다. 제주 서쪽 마을과 오름을 함께 걸어요!',
    languages: ['ko', 'en', 'ja'], regions: ['jeju'], interests: ['hiking', 'olle', 'food', 'cafe'], specialties: ['올레 14코스', '새별오름', '고기국수 맛집'], group: 4, hours: ['08:00', '18:00'], since: at(-450) },
  { key: 'guide-gyeongju', email: 'guide.gyeongju@jetpool.dev', name: '경주 문화해설 지훈', type: 'PAID', city: 'Gyeongju', lat: 35.8347, lng: 129.2190, hourly: 30000,
    headline: '자전거로 달리는 천년 고도 해설', bio: '문화재학을 전공한 경주 토박이 해설사입니다. 대릉원·첨성대·월정교를 자전거로 이어 달리며 신라 이야기를 들려드려요.',
    languages: ['ko', 'en'], regions: ['gyeongju'], interests: ['history', 'bike', 'temple'], specialties: ['대릉원', '불국사', '교촌마을'], group: 6, hours: ['09:00', '18:00'],
    quals: ['BUSINESS_REGISTRATION'], since: at(-380) },
  { key: 'guide-jeonju', email: 'guide.jeonju@jetpool.dev', name: '전주 한옥 지킴이 은영', type: 'VOLUNTEER', city: 'Jeonju', lat: 35.8150, lng: 127.1530,
    headline: '한옥마을 자원봉사 해설 & 한지 공방 안내', bio: '전주 한옥마을에서 30년을 산 주민 해설사예요. 경기전과 오목대, 한지 공방, 남부시장 야시장까지 이웃처럼 안내합니다.',
    languages: ['ko', 'ja'], regions: ['jeonju'], interests: ['hanok', 'craft', 'food'], specialties: ['경기전', '한지 공방', '남부시장 야시장'], group: 8, hours: ['10:00', '17:00'], since: at(-610) },
  { key: 'guide-gangneung', email: 'guide.gangneung@jetpool.dev', name: '강릉 커피 큐레이터 도윤', type: 'PAID', city: 'Gangneung', lat: 37.7720, lng: 128.9478, hourly: 25000,
    headline: '강릉 로스터리 투어 큐레이터', bio: '바리스타 출신 커피 큐레이터입니다. 안목 커피거리부터 숨은 로스터리까지, 원두 이야기와 함께 강릉 바다를 걸어요.',
    languages: ['ko', 'en'], regions: ['gangneung'], interests: ['coffee', 'sea', 'photography'], specialties: ['안목 커피거리', '로스터리 투어', '경포호 노을'], group: 6, hours: ['10:00', '19:00'],
    quals: ['BUSINESS_REGISTRATION'], since: at(-300) },
  { key: 'guide-jejupro', email: 'guide.jejupro@jetpool.dev', name: 'Jeju Pro Guide Grace', type: 'PROFESSIONAL', city: 'Jeju', lat: 33.4580, lng: 126.9425, hourly: 60000,
    headline: 'UNESCO geopark certified guide', bio: "Licensed English/Chinese guide for Jeju's UNESCO sites — Seongsan Ilchulbong, Manjanggul lava tube and the Hallasan trails. 성산일출봉·만장굴·한라산 전문 해설 가이드입니다.",
    languages: ['en', 'ko', 'zh'], regions: ['jeju'], interests: ['hiking', 'geology', 'unesco'], specialties: ['성산일출봉', '만장굴', '한라산 영실'], group: 12, hours: ['07:00', '17:00'],
    quals: ['BUSINESS_REGISTRATION', 'GUIDE_LICENSE'], since: at(-720), locale: 'en-US' },
];

// Travel products (supplier: WONT Travel Club Tours). days = weekdays of the rolling departures (0 = Sunday).
const PRODUCTS = [
  { slug: 'jeju-oreum-sunrise', legacy: true, type: 'TOUR', city: 'Jeju', title: '제주 오름 일출 투어', price: 45000, minutes: 240, days: [6, 0], time: '05:30', capacity: 12, min: 4,
    summary: '새벽 오름 트레킹과 일출 감상',
    description: '해 뜨기 전 용눈이오름 인근 오름에 올라 제주 동쪽 바다 위로 떠오르는 해를 맞이합니다. 지역 해설가가 오름의 탄생과 제주 신화 이야기를 들려드리고, 하산 후에는 동네 해장국집에서 아침을 함께해요. 숙소 픽업(제주시·애월·한림) 포함.',
    terms: { tiers: [{ min_hours_before: 72, refund_pct: 100 }, { min_hours_before: 24, refund_pct: 50 }, { min_hours_before: 0, refund_pct: 0 }], fee_refundable: false, note: '출발 72시간 전까지 무료 취소, 24시간 전까지 50% 환불' } },
  { slug: 'seoul-palace-moonlight', type: 'TOUR', city: 'Seoul', title: '창덕궁 달빛 산책 & 북촌 야경 워킹 투어', price: 39000, minutes: 180, days: [4, 6], time: '19:00', capacity: 15, min: 4,
    summary: '청사초롱을 들고 걷는 궁궐의 밤과 북촌 골목 야경',
    description: '해 질 녘 창덕궁 돈화문에서 출발해 낙선재와 후원 입구까지 청사초롱 불빛을 따라 걷습니다. 궁궐 해설 후에는 북촌 한옥마을 골목의 야경 포인트를 돌고, 전통 찻집에서 대추차 한 잔으로 마무리해요. 한복 대여 옵션을 선택하면 더 특별한 사진을 남길 수 있습니다.',
    options: [['한복 대여 (2시간)', 15000]], terms: { tiers: [{ min_hours_before: 24, refund_pct: 100 }, { min_hours_before: 0, refund_pct: 0 }], note: '출발 24시간 전까지 무료 취소' } },
  { slug: 'busan-yacht-sunset', type: 'ACTIVITY', city: 'Busan', title: '광안리 선셋 요트 투어', price: 35000, minutes: 70, days: [5, 6, 0], time: '17:30', capacity: 40, min: 6,
    summary: '광안대교 아래로 지는 노을을 요트 위에서',
    description: '수영만 요트경기장에서 출발해 광안대교와 해운대 마린시티를 한 바퀴 도는 70분 세일링입니다. 선상에서 노을과 야경을 모두 즐길 수 있고, 갑판 포토존에서 크루가 사진을 찍어 드려요. 와인과 치즈 플레이트 옵션을 추가할 수 있습니다.',
    options: [['와인 1잔 + 치즈 플레이트', 12000]], terms: { tiers: [{ min_hours_before: 24, refund_pct: 100 }, { min_hours_before: 0, refund_pct: 0 }], note: '출발 24시간 전까지 무료 취소 · 기상 악화 시 전액 환불' } },
  { slug: 'gyeongju-heritage-bike', type: 'TOUR', city: 'Gyeongju', title: '경주 역사유적지구 자전거 투어', price: 32000, minutes: 240, days: [6], time: '09:30', capacity: 12, min: 3,
    summary: '대릉원에서 월정교까지, 신라 천년을 자전거로 잇는 반나절',
    description: '대릉원 앞에서 자전거를 빌려 첨성대, 계림, 교촌마을, 월정교, 동궁과 월지를 차례로 달립니다. 평지 위주의 코스라 초보자도 부담 없고, 곳곳에서 해설사가 신라 이야기를 들려드려요. 자전거·헬멧 대여와 생수 포함.',
    terms: { tiers: [{ min_hours_before: 48, refund_pct: 100 }, { min_hours_before: 0, refund_pct: 0 }], note: '출발 48시간 전까지 무료 취소' } },
  { slug: 'jeonju-hanok-cooking', type: 'ACTIVITY', city: 'Jeonju', title: '전주 한옥에서 비빔밥 쿠킹 클래스', price: 48000, minutes: 150, days: [0], time: '11:00', capacity: 10, min: 2,
    summary: '남부시장 장보기부터 전주비빔밥 완성까지, 한옥 부엌에서 배우는 한 끼',
    description: '남부시장에서 제철 나물과 육회 재료를 함께 고른 뒤 한옥 부엌으로 돌아와 전주비빔밥과 콩나물국을 만듭니다. 고명 올리는 법과 고추장 양념 비법까지 배우고, 마당 평상에서 함께 식사해요. 막걸리 페어링 옵션이 있습니다.',
    options: [['전주 막걸리 페어링', 8000]], terms: { tiers: [{ min_hours_before: 48, refund_pct: 100 }, { min_hours_before: 24, refund_pct: 50 }, { min_hours_before: 0, refund_pct: 0 }], note: '48시간 전까지 무료 취소, 24시간 전까지 50% 환불' } },
  { slug: 'gangneung-coffee-trail', type: 'TOUR', city: 'Gangneung', title: '강릉 커피 로스터리 트레일', price: 42000, minutes: 210, days: [6], time: '10:00', capacity: 12, min: 2,
    summary: '안목 커피거리와 숨은 로스터리 세 곳을 걷는 커피 산책',
    description: '안목해변 커피거리에서 시작해 강릉의 로스터리 세 곳을 차례로 방문합니다. 각 로스터리에서 원두 테이스팅과 핸드드립 시연을 보고, 마지막 카페에서는 직접 드립해 보는 시간을 가져요. 테이스팅 3회와 원두 100g 선물 포함.',
    terms: { tiers: [{ min_hours_before: 24, refund_pct: 100 }, { min_hours_before: 0, refund_pct: 0 }], note: '출발 24시간 전까지 무료 취소' } },
  { slug: 'yeosu-cablecar-ticket', type: 'TICKET', city: 'Yeosu', title: '여수 해상케이블카 크리스탈 캐빈 왕복권', price: 24000, minutes: 30, days: [6, 0], time: '10:00', capacity: 200, min: 1,
    summary: '바닥이 투명한 크리스탈 캐빈으로 건너는 여수 밤바다',
    description: '돌산공원과 자산공원을 잇는 해상케이블카 크리스탈 캐빈 왕복 이용권입니다. 이용일 하루 동안 운영 시간 내 언제든 탑승할 수 있고, 해 질 녘에는 돌산대교와 여수 밤바다 야경을 감상할 수 있어요. 모바일 바우처를 매표소에 제시하세요.',
    terms: { tiers: [{ min_hours_before: 24, refund_pct: 100 }, { min_hours_before: 0, refund_pct: 0 }], note: '이용일 전날까지 무료 취소' } },
  { slug: 'jeju-east-3day-package', type: 'PACKAGE', city: 'Jeju', title: '제주 동쪽 2박 3일 로컬 패키지 (숙박+오름+해녀 체험)', price: 390000, minutes: 3 * 1440, days: [5], time: '09:00', capacity: 12, min: 4,
    summary: '세화 해변 숙소 2박, 오름 일출, 해녀 물질 체험까지 한 번에',
    description: '세화 해변 앞 숙소 2박과 오름 일출 트레킹, 해녀학교 물질 체험, 성산 일대 로컬 맛집 투어를 묶은 소규모 패키지입니다. 제주공항 픽업과 일정 중 이동, 조식 2회가 포함돼요. 혼자 참가해도 좋은 6–12인 소그룹으로 진행합니다.',
    options: [['1인실 사용', 90000]], terms: { tiers: [{ min_hours_before: 168, refund_pct: 100 }, { min_hours_before: 72, refund_pct: 50 }, { min_hours_before: 0, refund_pct: 0 }], note: '출발 7일 전까지 무료 취소, 3일 전까지 50% 환불' } },
];

// Completed stays → reviews. [slug, reviewer, rating, body, check-out (days ago), nights, host reply?]
const STAY_REVIEWS = [
  ['seoul-hanok', 'traveler-seoyeon', 5, '마당에 앉아 기와지붕 너머 하늘을 보는 것만으로 힐링이었어요. 온돌방이 정말 따뜻했고 호스트님이 추천해 주신 계동길 카페도 최고!', 18, 3, '서연님, 다음에는 마당에 핀 꽃도 보여드릴게요 :)'],
  ['seoul-hanok', 'traveler-emma', 5, 'A beautifully restored hanok in the heart of Bukchon. Quiet at night, walkable to the palaces, and the host left a hand-drawn map of the neighbourhood.', 52, 4],
  ['seoul-hanok', 'traveler-junho', 4, '위치와 분위기는 완벽했습니다. 다만 한옥 특성상 화장실이 조금 좁아요. 그래도 다시 오고 싶은 곳!', 97, 2],
  ['seoul-apt', 'traveler-takeshi', 5, 'Fast Wi-Fi, a proper desk and a view of Seoul Forest. Perfect for a two-week workation in Seongsu.', 25, 6],
  ['seoul-apt', 'traveler-minji', 4, '성수 카페거리 바로 근처라 매일 다른 카페를 갔어요. 주방 살림이 잘 갖춰져 있어 장기 숙박에 좋습니다.', 74, 3],
  ['seoul-mangwon-house', 'traveler-haneul', 5, '옥상 텃밭에서 상추 따서 바비큐 했던 저녁이 잊히지 않아요. 망원시장 먹거리 투어도 강추!', 33, 3, '하늘님 덕분에 옥상이 더 빛났어요. 또 놀러 오세요!'],
  ['seoul-mangwon-house', 'traveler-lucas', 5, 'Felt like living in Seoul rather than visiting. The rooftop is magic at sunset and the market is two minutes away.', 88, 5],
  ['seoul-yeonnam-studio', 'traveler-jiwoo', 4, '작지만 알찬 공간이에요. 공항철도 타고 바로 와서 셀프 체크인이 편했습니다.', 14, 2],
  ['seoul-yeonnam-studio', 'traveler-emma', 5, 'Cozy studio right on the Gyeongui Line Forest Park. Great base for exploring Hongdae and Yeonnam.', 61, 3],
  ['seoul-yeonnam-studio', 'traveler-seoyeon', 4, '혼자 머물기 딱 좋았어요. 밤에는 산책로가 조금 붐비지만 방 안은 조용합니다.', 120, 2],
  ['seoul-hannam-villa', 'traveler-junho', 5, '부모님 모시고 3대 가족 여행으로 묵었는데 방마다 욕실이 있어 너무 편했어요. 테라스 야경 최고입니다.', 41, 3, '귀한 가족 여행에 함께할 수 있어 영광이었습니다.'],
  ['seoul-seochon-hanok', 'traveler-takeshi', 5, 'The cypress bath and the view of Inwangsan from the wooden porch were unforgettable. Lunch at Tongin Market is a must.', 29, 3],
  ['seoul-seochon-hanok', 'traveler-minji', 5, '서촌 골목 산책하기 너무 좋은 위치예요. 다기 세트로 아침마다 차 마시는 시간이 행복했습니다.', 83, 2, '차 시간을 즐겨 주셔서 기뻐요. 다음엔 다른 찻잎도 준비해 둘게요.'],
  ['busan-gwangalli-ocean', 'traveler-seoyeon', 5, '침대에 누워서 광안대교 야경을 볼 수 있어요. 주말 드론쇼는 거실에서 편하게 봤습니다!', 47, 2],
  ['busan-gwangalli-ocean', 'traveler-lucas', 4, 'Amazing view of the bridge. The lobby gets busy on weekends, but the room itself was spotless.', 105, 3, 'Thank you Lucas! We have since added a second lift for the weekend rush.'],
  ['busan-yeongdo-guesthouse', 'traveler-jiwoo', 5, '흰여울마을 골목 끝 바다 뷰가 정말 예뻐요. 라운지에서 만난 여행자들과 이야기 나눈 밤이 좋았습니다.', 37, 2],
  ['busan-yeongdo-guesthouse', 'traveler-haneul', 4, '가성비 최고. 언덕이 있어 짐이 많으면 조금 힘들 수 있어요.', 66, 2],
  ['busan-gijang-villa', 'traveler-minji', 5, '친구 다섯 명이서 수영장을 전세 낸 기분이었어요. 바비큐 데크에서 보는 일출이 정말 예뻤습니다.', 22, 2, '다음엔 기장 장어 맛집도 꼭 들러 보세요!'],
  ['busan-gijang-villa', 'traveler-emma', 5, 'A heated pool, sea breeze, and fresh eel from the Gijang market. We did not want to leave.', 79, 3],
  ['jeju-villa', 'guest', 5, '애월 노을을 매일 테라스에서 봤어요. 세탁건조기와 업무 공간 덕분에 워케이션이 정말 편했습니다.', 95, 5, '깔끔하게 사용해 주셔서 감사해요. 언제든 다시 오세요!'],
  ['jeju-villa', 'traveler-takeshi', 5, 'The lawn, the sunset, the quiet. Best stay of our Jeju trip.', 40, 4],
  ['jeju-villa', 'traveler-junho', 4, '사진보다 더 넓고 깨끗했어요. 차가 꼭 필요한 위치입니다.', 140, 3],
  ['jeju-hallim-stone-house', 'traveler-seoyeon', 5, '귤나무 마당에서 비양도를 보며 아침을 먹었어요. 돌집 특유의 아늑함이 있어요.', 58, 4],
  ['jeju-hallim-stone-house', 'traveler-lucas', 5, 'A traditional stone house five minutes from Hyeopjae beach. The host even picked tangerines with us!', 12, 5, 'It was a pleasure, Lucas. Come back for the next harvest!'],
  ['jeju-seogwipo-apt', 'traveler-minji', 5, '한 달 살기 하면서 올레길을 매일 걸었어요. 자전거 두 대가 있어서 서귀포 시내 다니기 편했습니다.', 115, 28],
  ['jeju-seogwipo-apt', 'traveler-haneul', 4, '시장이 가까워 장보기 좋고, 한라산 뷰가 덤이에요. 엘리베이터가 조금 느려요.', 30, 7],
  ['jeju-gujwa-studio', 'traveler-jiwoo', 5, '창가에서 보는 세화 바다 색이 정말 비현실적이에요. 혼자 쉬어가기 딱입니다.', 44, 3],
  ['gangneung-anmok-apt', 'guest', 5, '아침마다 바다 보며 커피 내리는 루틴이 생겼어요. KTX역에서도 가깝고 업무하기 좋았습니다.', 60, 7, '원두 리필 요청도 언제든 환영이에요. 다음 워케이션도 기다릴게요!'],
  ['gangneung-anmok-apt', 'traveler-emma', 4, 'Coffee street right outside and a big desk facing the sea. Parking was a bit tricky.', 19, 3],
  ['gangneung-gyeongpo-house', 'traveler-junho', 5, '아이들이 정원 그네를 너무 좋아했어요. 경포호 자전거 산책 강추합니다.', 27, 3],
  ['gangneung-gyeongpo-house', 'traveler-takeshi', 4, 'Spacious house among pine trees. Great for a family; you need a car for groceries.', 92, 2],
  ['sokcho-seorak-cabin', 'traveler-seoyeon', 5, '울산바위가 창문 가득 보여요! 데크에서 별 보며 바비큐한 밤이 최고였습니다.', 35, 2],
  ['sokcho-seorak-cabin', 'traveler-lucas', 5, 'Woke up to Ulsanbawi rock every morning. Cosy and warm with the ondol floor.', 70, 3, 'Merci Lucas! Your photos of the ridge were stunning.'],
  ['sokcho-harbor-studio', 'traveler-haneul', 4, '영금정 일출 보려고 묵었는데 창문으로 바로 보여요. 시장까지 걸어서 5분!', 16, 2],
  ['gyeongju-hwangnam-hanok', 'guest', 4, '대릉원 바로 옆이라 밤 산책이 정말 좋았어요. 경주빵 조식도 맛있었습니다. 방음은 조금 아쉬워요.', 30, 2, '소중한 의견 감사합니다. 창호에 방음 커튼을 새로 달았어요!'],
  ['gyeongju-hwangnam-hanok', 'traveler-minji', 5, '편백 욕조 최고. 첨성대 야경까지 걸어서 다녀왔어요.', 55, 2],
  ['gyeongju-hwangnam-hanok', 'traveler-emma', 5, 'Lovely hanok right next to the royal tombs. The breakfast tea and Gyeongju bread were a sweet touch.', 101, 2],
  ['gyeongju-bomun-villa', 'traveler-jiwoo', 5, '벚꽃 시즌에 묵었는데 테라스가 꽃길 그 자체였어요. 아이랑 경주월드 가기도 편해요.', 180, 3],
  ['jeonju-hanok-village', 'traveler-takeshi', 5, 'Staying inside the hanok village meant quiet mornings before the crowds. Great bibimbap tips from the host.', 21, 2, 'ありがとうございます, Takeshi! See you again in Jeonju.'],
  ['jeonju-hanok-village', 'traveler-junho', 4, '한옥마을 한가운데라 어디든 걸어서 다닐 수 있어요. 주말 낮에는 바깥이 조금 시끄러워요.', 64, 2],
  ['jeonju-gaeksa-room', 'traveler-lucas', 4, 'Clean private room with its own bathroom, surrounded by cafés. Good value.', 9, 2],
  ['jeonju-gaeksa-room', 'traveler-seoyeon', 4, '혼자 여행에 딱 맞는 크기예요. 객리단길 카페 투어하기 최고의 위치!', 76, 1],
  ['yeosu-dolsan-ocean', 'traveler-haneul', 5, '여수 밤바다 노래가 저절로 나오는 뷰예요. 웰컴 노트의 맛집 리스트가 전부 성공이었습니다.', 50, 2, '맛집 리스트가 도움이 됐다니 뿌듯하네요!'],
  ['yeosu-dolsan-ocean', 'traveler-minji', 5, '테라스에서 돌산대교 야경 보면서 와인 한 잔. 케이블카 타러 가기도 가까워요.', 133, 2],
];
const HOST_REVIEW_BODY = {
  ko: ['호스트님의 친절한 안내 덕분에 편하게 지냈어요.', '빠른 답장과 꼼꼼한 체크인 안내 감사합니다.', '동네 맛집 추천이 전부 성공이었어요!', '세심하게 준비해 주신 웰컴 노트 감동이었어요.'],
  en: ['Super responsive and kind host.', 'Clear check-in instructions and great local tips.', 'Thoughtful host — everything was ready when we arrived.'],
};
// host → guest reviews for the guest persona's stays
const GUEST_REVIEWS = { 'jeju-villa': [5, '집을 정말 깨끗하게 사용해 주셨어요. 언제든 다시 오세요!'], 'gangneung-anmok-apt': [5, '체크아웃 정리까지 완벽했던 게스트입니다.'], 'gyeongju-hwangnam-hanok': [5, '한옥을 아껴 주셔서 감사했습니다.'] };

// Upcoming confirmed stays. [key, slug, guest, check-in (days from today), nights, guests, booked (days ago), guest message]
const UPCOMING_STAYS = [
  ['guest-hallim', 'jeju-hallim-stone-house', 'guest', 30, 7, 2, 9, '어머니와 함께 일주일 머물 예정이에요. 마당 귤 따기도 할 수 있을까요?'],
  ['takeshi-yeonnam', 'seoul-yeonnam-studio', 'traveler-takeshi', 5, 3, 1, 12, null],
  ['junho-mangwon', 'seoul-mangwon-house', 'traveler-junho', 9, 3, 4, 20, '아이 둘과 함께 가요. 유아용 식기가 있을까요?'],
  ['emma-seochon', 'seoul-seochon-hanok', 'traveler-emma', 18, 4, 2, 15, null],
  ['haneul-gwangalli', 'busan-gwangalli-ocean', 'traveler-haneul', 20, 3, 2, 7, null],
  ['lucas-hwangnam', 'gyeongju-hwangnam-hanok', 'traveler-lucas', 33, 2, 1, 4, null],
  ['minji-seogwipo', 'jeju-seogwipo-apt', 'traveler-minji', 40, 28, 1, 25, '한 달 동안 원격 근무를 할 예정이라 책상 공간이 넉넉하면 좋겠어요.'],
];

// Past guide bookings → GUIDE reviews. [guide, traveler, days ago, start, end, rating, body]
const GUIDE_REVIEWS = [
  ['guide-friend', 'traveler-emma', 45, '14:00', '17:00', 5, 'Mina showed us hidden cafés in Seongsu and the best tteokbokki in Mangwon market. Felt like hanging out with a friend.'],
  ['guide-friend', 'traveler-jiwoo', 80, '15:00', '18:00', 5, '서울 토박이만 아는 골목 맛집을 알게 됐어요. 친구랑 수다 떨듯 편했습니다.'],
  ['guide-pro', 'guest', 40, '10:00', '13:00', 5, '경복궁 해설이 정말 깊이 있었어요. 궁궐 건축 이야기에 시간 가는 줄 몰랐습니다.'],
  ['guide-pro', 'traveler-takeshi', 70, '09:30', '12:30', 5, 'Incredible knowledge of Joseon history, explained in fluent Japanese.'],
  ['guide-busan', 'traveler-lucas', 25, '13:00', '16:00', 5, 'Hyunwoo volunteered a whole afternoon to show us old-town Busan and the 40 Steps. So generous!'],
  ['guide-busan', 'traveler-seoyeon', 90, '10:00', '13:00', 4, '원도심 역사 해설이 알찼어요. 감천마을까지 같이 걸어 주셨습니다.'],
  ['guide-jeju', 'traveler-minji', 35, '09:00', '13:00', 5, '올레길 같이 걷고 숨은 고기국수 집까지! 제주 친구가 생긴 기분이에요.'],
  ['guide-gyeongju', 'traveler-emma', 50, '09:30', '13:30', 5, 'Biking between the royal tombs and temples with Jihoon was the highlight of Gyeongju.'],
  ['guide-gyeongju', 'traveler-junho', 110, '09:00', '12:00', 4, '자전거 코스가 알찼고 설명도 재밌었어요. 더운 날엔 오전 투어 추천!'],
  ['guide-jeonju', 'traveler-takeshi', 20, '10:00', '12:30', 5, 'She explained the hanok village architecture and took us to a hanji paper workshop.'],
  ['guide-gangneung', 'traveler-haneul', 15, '13:00', '16:00', 5, '로스터리 세 곳을 돌며 원두 이야기를 들으니 커피가 달리 보여요.'],
  ['guide-jejupro', 'traveler-lucas', 60, '08:00', '12:00', 5, "Grace's geology tour of Seongsan and Manjanggul was world-class."],
  ['guide-jejupro', 'traveler-jiwoo', 100, '07:00', '12:00', 5, '한라산 영실 코스 전문 가이드! 사진 포인트까지 다 알려 주셨어요.'],
];

// Past fulfilled orders → product reviews. [product, buyer, departure days ago, qty, rating, body]
const ORDER_REVIEWS = [
  ['jeju-oreum-sunrise', 'traveler-seoyeon', 28, 2, 5, '새벽 공기 마시며 오른 오름에서 본 일출, 평생 기억할 거예요.'],
  ['jeju-oreum-sunrise', 'traveler-lucas', 28, 1, 4, 'Early start but worth it. Bring a warm jacket!'],
  ['seoul-palace-moonlight', 'traveler-emma', 22, 2, 5, 'Changdeokgung by lantern light was magical, and the jujube tea at the end was the perfect finish.'],
  ['busan-yacht-sunset', 'guest', 5, 2, 5, '광안대교 아래로 지는 노을을 요트에서 보다니! 사진이 정말 잘 나와요.'],
  ['busan-yacht-sunset', 'traveler-haneul', 40, 2, 5, '노을 타이밍이 완벽했어요. 크루분들이 사진도 많이 찍어 주셨습니다.'],
  ['gyeongju-heritage-bike', 'traveler-junho', 34, 3, 4, '평지 위주라 초보도 OK. 가이드 설명이 재밌어서 아이들도 좋아했어요.'],
  ['jeonju-hanok-cooking', 'traveler-takeshi', 19, 1, 5, 'Learned to make bibimbap from scratch in a real hanok kitchen. The makgeolli pairing was great.'],
  ['gangneung-coffee-trail', 'traveler-minji', 12, 2, 5, '커피 덕후라면 무조건! 로스터리 사장님들 이야기가 재밌어요.'],
  ['yeosu-cablecar-ticket', 'traveler-jiwoo', 9, 2, 4, '크리스탈 캐빈 바닥이 투명해서 짜릿해요. 주말엔 대기가 길어요.'],
  ['jeju-east-3day-package', 'traveler-haneul', 45, 1, 5, '숙소·오름·해녀 체험이 한 번에! 혼자 갔는데도 전혀 외롭지 않았어요.'],
];
// Upcoming paid orders on rolling departures. [key, product, buyer, departure index, qty]
const UPCOMING_ORDERS = [
  ['emma-palace', 'seoul-palace-moonlight', 'traveler-emma', 1, 2],
  ['takeshi-palace', 'seoul-palace-moonlight', 'traveler-takeshi', 1, 3],
  ['lucas-cooking', 'jeonju-hanok-cooking', 'traveler-lucas', 1, 2],
  ['seoyeon-cooking', 'jeonju-hanok-cooking', 'traveler-seoyeon', 1, 1],
  ['minji-coffee', 'gangneung-coffee-trail', 'traveler-minji', 2, 2],
];

// ------------------------------------------------------------------------------------------------ seed
await db.query('BEGIN');
try {
  const admin = await user('admin', 'admin@jetpool.dev', 'JETPOOL Admin', ['ADMIN', 'COMPLIANCE', 'ACCOUNTING', 'SUPPORT', 'EDITOR']);
  const accountant = await user('accountant', 'accounting@jetpool.dev', '정산 담당', ['ACCOUNTING']);
  const hostA = await user('host-a', 'host.seoul@jetpool.dev', '서울 호스트', ['HOST'], true, { bio: '북촌·성수·망원·잠실, 동네마다 다른 서울의 일상을 소개하는 호스트입니다.' });
  const hostB = await user('host-b', 'host.jeju@jetpool.dev', '제주 호스트', ['HOST'], true, { bio: '제주 이주 8년 차, 돌집과 바다를 사랑하는 호스트예요.' });
  const guest = await user('guest', 'guest@jetpool.dev', '여행자 김', [], true, { bio: '한 달에 한 도시씩 살아보는 중인 직장인 여행자입니다.', country: 'KR' });
  const exchanger = await user('exchanger', 'exchange.busan@jetpool.dev', '부산 교환회원', ['HOST'], true, { bio: '해운대에 사는 프리랜서 디자이너 부부. 매년 한 달은 다른 도시 집과 맞교환해 살아요.' });
  const guideFriend = await user('guide-friend', 'friend.guide@jetpool.dev', 'Local Friend Mina', ['GUIDE']);
  const guidePro = await user('guide-pro', 'pro.guide@jetpool.dev', 'Pro Guide Jun', ['GUIDE']);
  const supplierUser = await user('supplier', 'supplier@jetpool.dev', 'WONT Tours', ['SUPPLIER']);

  const U = { admin, accountant, hostA, hostB, guest, exchanger, 'guide-friend': guideFriend, 'guide-pro': guidePro, supplier: supplierUser };
  for (const [key, email, name, opts] of TRAVELERS) U[key] = await user(key, email, name, [], true, opts);
  for (const [key, email, name, , , , , since] of NEW_HOSTS) U[key] = await user(key, email, name, ['HOST'], true, { since });
  for (const g of GUIDES.filter((x) => !x.legacy)) U[g.key] = await user(g.key, g.email, g.name, ['GUIDE'], true, { since: g.since, locale: g.locale, languages: g.languages });
  await run(`UPDATE user_preferences SET travel_styles = $2, interests = $3 WHERE user_id = $1 AND travel_styles = '{}' AND interests = '{}'`,
    [guest, ['month-stay', 'workation', 'local-life'], ['food', 'nature', 'history', 'cafe']]);

  // ---- hosts: approved + verified profiles, application history, payout account (tokenized reference only)
  const HOSTS = [
    ['hostA', '서울 호스트', '서울에서 10년째 게스트를 맞고 있어요. 북촌 한옥부터 망원동 단독주택까지, 동네마다 다른 서울의 일상을 소개합니다.', 98.0, ['Busan', 'Jeju'], '북촌 골목 안 마당이 있는 한옥과 잠실 석촌호수 뷰 아파트를 맞교환으로 열어 두었습니다.'],
    ['hostB', '제주 호스트', '제주 이주 8년 차. 애월과 한림, 서귀포에서 돌집과 빌라를 운영하며 한달살기 손님을 맞고 있어요.', 97.0, ['Seoul', 'Busan'], '애월 오션뷰 빌라와 한림 돌담 독채를 맞교환으로 열어 두었습니다. 렌터카 없이도 버스가 잘 다녀요.'],
    ['exchanger', '부산 교환회원', '해운대에 사는 프리랜서 디자이너 부부입니다. 매년 한 달은 다른 도시 집과 맞교환해 살아요.', 100.0, ['Seoul', 'Jeju'], '해운대 해변까지 도보 5분, 방 2개 아파트입니다. 재택근무 책상과 자전거 2대가 있어요.'],
    ...NEW_HOSTS.map(([key, , name, about, rate, prefs, home]) => [key, name, about, rate, prefs, home]),
  ];
  for (const [key, name, about, rate] of HOSTS) {
    const h = U[key];
    await run(
      `INSERT INTO host_profiles(user_id, display_name, about, verification_status, status, response_rate) VALUES ($1,$2,$3,'VERIFIED','APPROVED',$4)
       ON CONFLICT (user_id) DO UPDATE SET about = coalesce(host_profiles.about, EXCLUDED.about), response_rate = coalesce(host_profiles.response_rate, EXCLUDED.response_rate)
        WHERE host_profiles.about IS NULL OR host_profiles.response_rate IS NULL`,
      [h, name, about, rate],
    );
    const appId = uid(`host-application:${key}`);
    const created = await ins('host_applications',
      `INSERT INTO host_applications(id, user_id, status, checklist, reviewer_id, created_at, decided_at)
       SELECT $1::uuid, $2::uuid, 'APPROVED', $3::jsonb, $4::uuid, $5::timestamptz, $6::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM host_applications WHERE user_id = $2::uuid) ON CONFLICT DO NOTHING`,
      [appId, h, J({ emailVerified: true, identityVerified: true, hostVerified: true, payoutAccount: 'VERIFIED' }), admin, at(-700, '10:00'), at(-698, '15:00')]);
    if (created) {
      await history('host_profile', h, [[null, 'APPLIED', at(-700, '10:00'), h, 'USER', 'host application submitted'], ['APPLIED', 'APPROVED', at(-698, '15:00'), admin, 'ADMIN', 'DEV seed: host approved']]);
    }
    for (const subject of ['IDENTITY', 'HOST']) {
      await ins('verification_cases', `INSERT INTO verification_cases(id, user_id, subject_type, status, reviewer_id, decision_reason, submitted_at, decided_at)
        VALUES ($1,$2,$3,'APPROVED',$4,'DEV seed: verified demo host',$5,$6) ON CONFLICT DO NOTHING`, [uid(`verification:${key}:${subject}`), h, subject, admin, at(-700, '09:00'), at(-699, '11:00')]);
    }
    await ins('payout_accounts', `INSERT INTO payout_accounts(id, user_id, bank_code, account_last4, account_token, holder_name, status)
      VALUES ($1,$2,'004',$3,$4,$5,'VERIFIED') ON CONFLICT DO NOTHING`, [uid(`payout:${key}`), h, String(1000 + (parseInt(sha256(key).slice(0, 4), 16) % 9000)), `dev-token-${sha256(key).slice(0, 16)}`, name]);
  }

  // ---- listings
  const policies = Object.fromEntries((await run(`SELECT id, code, name, tiers, service_fee_refundable FROM cancellation_policies`)).rows.map((r) => [r.code, r]));
  const PROP = {};
  for (const p of PROPERTIES) {
    const id = uid(`property:${p.slug}`);
    const hostId = U[p.host];
    const room = p.room ?? 'ENTIRE';
    PROP[p.slug] = { ...p, id, hostId };
    await run(
      `INSERT INTO properties(id, host_id, slug, title, summary, description, property_type, room_type, max_guests, bedrooms, beds, bathrooms,
                              lat, lng, city, region, rental_enabled, exchange_enabled, instant_book, base_price_minor, cleaning_fee_minor,
                              min_nights, max_nights, cancellation_policy_id, status, paid_booking_enabled, published_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'PUBLISHED',$17,$25,$26)
       ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, description = EXCLUDED.description, min_nights = EXCLUDED.min_nights,
              max_nights = EXCLUDED.max_nights, instant_book = EXCLUDED.instant_book
        WHERE properties.description LIKE '%JETPOOL 데모 숙소입니다.%'`,
      [id, hostId, p.slug, p.title, p.summary, p.description, p.type, room, p.guests, p.bedrooms, p.beds, p.baths, p.lat, p.lng, p.city, p.region,
        p.rental, p.exchange, !!p.instant, p.price, p.cleaning, p.minN, p.maxN, policies[p.policy].id, at(-p.listedAgo, '10:00'), at(-p.listedAgo - 6, '09:00')],
    );
    const areaLabel = p.area.includes(p.cityKo) ? p.area : `${p.cityKo} ${p.area}`;
    await run(
      `INSERT INTO property_addresses(property_id, line1, line2, postal_code, city, region, public_area_label) VALUES ($1,$2,'DEV 데모 데이터 — 실제 주소 아님',$3,$4,$5,$6)
       ON CONFLICT (property_id) DO UPDATE SET line1 = EXCLUDED.line1, line2 = EXCLUDED.line2, postal_code = EXCLUDED.postal_code, public_area_label = EXCLUDED.public_area_label
        WHERE property_addresses.line1 LIKE '% 데모로 1'`,
      [id, p.line1, p.postal, p.city, p.region, areaLabel],
    );
    const r = p.rules ?? {};
    await run(
      `INSERT INTO house_rules(property_id, smoking_allowed, pets_allowed, events_allowed, quiet_hours, extra_rules) VALUES ($1,false,$2,false,$3,$4)
       ON CONFLICT (property_id) DO UPDATE SET pets_allowed = EXCLUDED.pets_allowed, extra_rules = EXCLUDED.extra_rules WHERE house_rules.extra_rules IS NULL`,
      [id, !!r.pets, r.quiet ?? '22:00-08:00', r.extra ?? null],
    );
    for (const a of [...new Set([...AM_BASE, ...p.amenities])]) {
      await ins('property_amenities', `INSERT INTO property_amenities(property_id, amenity_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, a]);
    }
    const photos = MEDIA_ASSIGNED_STAYS.has(p.slug) ? [] : artUrls(p.art).slice(0, 6); // real photos come from seed-media.mjs
    for (const [i, u] of photos.entries()) {
      const mid = uid(`media:${p.slug}:${i}`);
      await run(
        `INSERT INTO media_assets(id, owner_id, storage_key, public_url, purpose, visibility, mime_type, byte_size, width, height, status, moderation_status, ready_at, created_at)
         VALUES ($1,$2,$3,$4,'PROPERTY','PUBLIC','image/svg+xml',$5,800,600,'READY','APPROVED',$6,$6)
         ON CONFLICT (id) DO UPDATE SET public_url = EXCLUDED.public_url, byte_size = EXCLUDED.byte_size
          WHERE media_assets.storage_key LIKE 'seed/%' AND media_assets.public_url IS DISTINCT FROM EXCLUDED.public_url`,
        [mid, hostId, `seed/${p.slug}/${i}.svg`, u, fileSize(u), at(-p.listedAgo - 6, '09:30')],
      );
      await run(
        `INSERT INTO property_media(property_id, media_id, sort_order, caption) VALUES ($1,$2,$3,$4)
         ON CONFLICT (property_id, media_id) DO UPDATE SET sort_order = EXCLUDED.sort_order, caption = EXCLUDED.caption
          WHERE property_media.caption IS DISTINCT FROM EXCLUDED.caption OR property_media.sort_order <> EXCLUDED.sort_order`,
        [id, mid, i, CAPTIONS[i]],
      );
    }
    if (p.weekly) await ins('rate_rules', `INSERT INTO rate_rules(id, property_id, rule_type, params, priority) VALUES ($1,$2,'WEEKLY_DISCOUNT',$3,100) ON CONFLICT DO NOTHING`, [uid(`rate:${p.slug}:weekly`), id, J({ bps: p.weekly, min_nights: 7 })]);
    if (p.monthly) await ins('rate_rules', `INSERT INTO rate_rules(id, property_id, rule_type, params, priority) VALUES ($1,$2,'MONTHLY_DISCOUNT',$3,100) ON CONFLICT DO NOTHING`, [uid(`rate:${p.slug}:monthly`), id, J({ bps: p.monthly, min_nights: 28 })]);
    if (p.rental) {
      await ins('property_permits', `INSERT INTO property_permits(id, property_id, permit_type, permit_no, jurisdiction, valid_from, valid_until, status, reviewer_id, decision_reason, verified_at)
        VALUES ($1,$2,$3,$4,$5,'2025-01-01','2028-12-31','VERIFIED',$6,'DEV seed: placeholder permit (not a real registration)',$7) ON CONFLICT DO NOTHING`,
        [uid(`permit:${p.slug}`), id, PERMIT_TYPE[p.type], `DEV-${p.region}-${codeFor(`permit:${p.slug}`, 6)}`, p.region, admin, at(-p.listedAgo - 2, '14:00')]);
      await ins('compliance_decisions', `INSERT INTO compliance_decisions(id, subject_type, subject_id, decision, reasons, rules_evaluated, evaluated_at, evaluated_by)
        VALUES ($1,'PROPERTY',$2,'ALLOW','[]',$3,$4,'SYSTEM') ON CONFLICT DO NOTHING`,
        [uid(`compliance-decision:${p.slug}`), id, J([{ ruleId: uid('rule:compliance:dev'), ruleKey: 'dev-kr-stay', requiredPermits: [] }]), at(-p.listedAgo, '09:55')]);
    }
  }

  // ---- Home Exchange profiles (ELIGIBLE: identity verified + exchange home + complete profile)
  for (const [key, , , , prefs, home] of HOSTS) {
    await run(
      `INSERT INTO exchange_profiles(user_id, status, home_description, preferred_destinations) VALUES ($1,'ELIGIBLE',$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET home_description = EXCLUDED.home_description WHERE exchange_profiles.home_description IS NULL`,
      [U[key], home, prefs],
    );
  }

  // ---- guides
  for (const g of GUIDES) {
    const gid = U[g.key];
    const paid = g.type === 'PAID' || g.type === 'PROFESSIONAL';
    for (const qt of g.quals ?? []) {
      await ins('guide_qualifications', `INSERT INTO guide_qualifications(id, guide_id, qualification_type, reference_no, valid_until, status, verified_by, verified_at)
        VALUES ($1,$2,$3,$4,'2028-12-31','VERIFIED',$5,$6) ON CONFLICT DO NOTHING`, [uid(`qualification:${g.key}:${qt}`), gid, qt, `DEV-${codeFor(`${g.key}:${qt}`, 8)}`, admin, at(-300, '11:00')]);
    }
    await run(
      `INSERT INTO guide_profiles(user_id, guide_type, headline, bio, languages, regions, interests, specialties, city, lat, lng, verification_status, status,
                                  paid_enabled, hourly_price_minor, max_group_size, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'VERIFIED','PUBLISHED',$12,$13,$14,coalesce($15::timestamptz, now()))
       ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, regions = EXCLUDED.regions, specialties = EXCLUDED.specialties, max_group_size = EXCLUDED.max_group_size
        WHERE guide_profiles.bio = $16`,
      [gid, g.type, g.headline, g.bio, g.languages, g.regions, g.interests, g.specialties, g.city, g.lat, g.lng, paid, paid ? g.hourly : null, g.group, g.since ?? null, g.legacyBio ?? null],
    );
    await ins('verification_cases', `INSERT INTO verification_cases(id, user_id, subject_type, status, reviewer_id, decision_reason, submitted_at, decided_at)
      VALUES ($1,$2,'GUIDE','APPROVED',$3,'DEV seed: verified demo guide',$4,$5) ON CONFLICT DO NOTHING`, [uid(`verification:${g.key}:GUIDE`), gid, admin, at(-320, '09:00'), at(-318, '11:00')]);
    // rolling daily availability windows for the next 8 weeks, keyed by date. Once a guide publishes slots, offers
    // must fit inside them (guide/availability.ts assertGuideWindowFree), so the demo windows are deliberately wide.
    for (let n = 1; n <= 56; n++) {
      const d = day(n);
      await ins('guide_availability', `INSERT INTO guide_availability(id, guide_id, start_at, end_at, status) VALUES ($1,$2,$3,$4,'AVAILABLE') ON CONFLICT DO NOTHING`,
        [uid(`guide-availability:${g.key}:${d}`), gid, `${d}T${g.hours[0]}:00+09:00`, `${d}T${g.hours[1]}:00+09:00`]);
    }
  }

  // Older seeds gave the PROFESSIONAL demo guide no qualification, so the worker's paid gate hid it
  // (audit guide.paid_disabled). Now that the seed provides the verified qualification, republish such a seed-owned
  // profile — only when that automatic gate is still the latest decision on it (never a guide's own unpublish).
  const paidSeedGuides = GUIDES.filter((g) => g.type === 'PAID' || g.type === 'PROFESSIONAL').map((g) => U[g.key]);
  const republished = await run(
    `UPDATE guide_profiles g SET status = 'PUBLISHED', paid_enabled = true
      WHERE g.user_id = ANY($1::uuid[]) AND g.status = 'HIDDEN'
        AND EXISTS (SELECT 1 FROM guide_qualifications q WHERE q.guide_id = g.user_id AND q.qualification_type = 'BUSINESS_REGISTRATION'
                     AND q.status = 'VERIFIED' AND (q.valid_until IS NULL OR q.valid_until >= current_date))
        AND (SELECT a.action FROM audit_logs a WHERE a.resource_type = 'guide_profile' AND a.resource_id = g.user_id::text
              ORDER BY a.created_at DESC LIMIT 1) = 'guide.paid_disabled'
      RETURNING g.user_id`,
    [paidSeedGuides],
  );
  for (const r of republished.rows) {
    bump('guide_profiles (republished)');
    await run(`INSERT INTO audit_logs(actor_id, actor_roles, action, resource_type, resource_id, before_state, after_state, reason, correlation_id, category)
      VALUES (NULL, '{}', 'guide.published', 'guide_profile', $1, '{"status":"HIDDEN","paidEnabled":false}', '{"status":"PUBLISHED","paidEnabled":true}',
              'DEV seed: verified BUSINESS_REGISTRATION qualification seeded; paid gate passes again', 'seed-dev', 'COMPLIANCE')`, [r.user_id]);
  }

  // ---- travel catalogue (supplier MOR: JETPOOL, 15 % commission)
  const supplierId = uid('supplier:wont');
  await run(`INSERT INTO suppliers(id, owner_user_id, name, supplier_type, merchant_of_record, commission_bps, status)
             VALUES ($1,$2,'WONT Travel Club Tours','TOUR_OPERATOR','JETPOOL',1500,'APPROVED') ON CONFLICT DO NOTHING`, [supplierId, supplierUser]);
  await ins('payout_accounts', `INSERT INTO payout_accounts(id, user_id, bank_code, account_last4, account_token, holder_name, status)
    VALUES ($1,$2,'088','4821',$3,'WONT Travel Club Tours','VERIFIED') ON CONFLICT DO NOTHING`, [uid('payout:supplier'), supplierUser, `dev-token-${sha256('supplier').slice(0, 16)}`]);
  const productId = uid('product:jeju-oreum');
  await run(`INSERT INTO travel_products(id, supplier_id, type, slug, title, summary, city, duration_minutes, base_price_minor, status, cancellation_terms)
             VALUES ($1,$2,'TOUR','jeju-oreum-sunrise','제주 오름 일출 투어','새벽 오름 트레킹과 일출 감상', 'Jeju', 240, 45000, 'PUBLISHED', '{"full_refund_hours":72}')
             ON CONFLICT DO NOTHING`, [productId, supplierId]);
  for (let d = 7; d <= 35; d += 7) {
    await run(`INSERT INTO travel_departures(id, product_id, starts_at, capacity, min_participants) VALUES ($1,$2, now() + make_interval(days => $3), 12, 4) ON CONFLICT DO NOTHING`,
      [uid(`departure:${d}`), productId, d]);
  }
  const PRODUCT = {};
  for (const [i, p] of PRODUCTS.entries()) {
    const id = p.legacy ? productId : uid(`product:${p.slug}`);
    PRODUCT[p.slug] = { ...p, id, departures: [] };
    if (p.legacy) {
      await run(`UPDATE travel_products SET description = $2, cancellation_terms = $3 WHERE id = $1 AND description IS NULL`, [id, p.description, J(p.terms)]);
    } else {
      await ins('travel_products', `INSERT INTO travel_products(id, supplier_id, type, slug, title, summary, description, city, duration_minutes, base_price_minor, status, cancellation_terms, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PUBLISHED',$11, now() - make_interval(days => $12)) ON CONFLICT DO NOTHING`,
        [id, supplierId, p.type, p.slug, p.title, p.summary, p.description, p.city, p.minutes, p.price, J(p.terms), i * 9]);
    }
    for (const [k, [name, price]] of (p.options ?? []).entries()) {
      await ins('travel_product_options', `INSERT INTO travel_product_options(id, product_id, name, price_minor) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [uid(`option:${p.slug}:${k}`), id, name, price]);
    }
    // rolling departures on the product's weekdays for the next 6 weeks (≥ 3 days out), keyed by date
    for (let n = 3; n < 45; n++) {
      const d = day(n);
      if (!p.days.includes(weekdayOf(d))) continue;
      const depId = uid(`departure:${p.slug}:${d}`);
      const startsAt = `${d}T${p.time}:00+09:00`;
      await ins('travel_departures', `INSERT INTO travel_departures(id, product_id, starts_at, ends_at, capacity, min_participants, created_at)
        VALUES ($1,$2,$3,$4,$5,$6, now()) ON CONFLICT DO NOTHING`, [depId, id, startsAt, plusMin(startsAt, p.minutes), p.capacity, p.min]);
      PRODUCT[p.slug].departures.push(depId);
    }
  }

  // ---- CMS: legacy WONT Travel Club content, destinations, FAQs, pages
  const CMS = [
    ['PAGE', 'jetpool-charter', 'JETPOOL 전세기 공유', 720,
      '같은 곳으로 떠나고 싶은 사람들이 모이면 노선이 열립니다. WONT Travel Club에서 시작된 전세기 공유 여행을 JETPOOL에서 이어갑니다. 현재는 사전 수요 접수와 상담만 받고 있어요.',
      '## 전세기 공유는 이렇게 진행됩니다\n\n1. 가고 싶은 도시와 날짜, 인원을 남겨 주세요.\n2. 같은 노선을 원하는 수요가 모이면 운항사·등록 여행사와 운항을 협의합니다.\n3. 노선이 확정되면 등록 여행사가 좌석 판매와 발권을 진행합니다.\n\n> 현재 JETPOOL에서는 전세기 직접 예약·결제를 제공하지 않습니다. 확정 전까지는 비용이 발생하지 않는 사전 수요 조사입니다.',
      { sections: [
        { key: 'flight-share', title: '플라이트 쉐어', body: '같은 노선을 원하는 여행자들과 좌석을 나누는 공유 운항 상담.' },
        { key: 'group-charter', title: '단체 전세기', body: '동호회·기업 워크숍처럼 한 그룹이 함께 떠나는 전세기 상담.' },
        { key: 'concierge', title: '컨시어지', body: '숙소·가이드·투어까지 JETPOOL에서 하나의 여행으로 연결합니다.' },
      ], routes: [
        { title: '인천 → 오키나와', period: '4박 5일 · 수요 모집 중', status: 'OPEN' },
        { title: '김포 → 제주 (기업 워크숍)', period: '2박 3일 · 운항 협의 중', status: 'NEGOTIATING' },
        { title: '김해 → 다낭', period: '5박 6일 · 수요 모집 중', status: 'OPEN' },
      ], cta: { label: '상담 신청', action: 'POST /v1/charter/requests' } },
      { title: 'JETPOOL 전세기 공유 — 사전 수요 접수', description: '같은 노선을 원하는 여행자가 모이면 전세기가 뜹니다. 상담 신청만 받고 있어요.', og: { image: '/art/postcards/coast.svg', type: 'website' } },
      '전세기를 함께 나누는 새로운 여행 방식. 현재는 상담 신청만 받고 있습니다.'],
    ['PAGE', 'wont-home', 'WONT Travel Club → JETPOOL', 30,
      '한달살기 맞교환, 전세기 공유, Local Life — WONT Travel Club의 세 가지 여행을 JETPOOL에서 이어갑니다.', null,
      { blocks: [
        { key: 'month-exchange', art: 'jeju', title: '한달살기 맞교환', body: '내 집을 비우는 동안 다른 도시의 집에서 한 달을 살아보세요. 검증된 회원끼리, 숙박비 없이 집을 맞교환합니다.', cta: '홈 맞교환 둘러보기', href: '/exchange' },
        { key: 'charter', art: 'coast', title: '전세기 공유 JETPOOL', body: '함께 타면 더 가까워지는 여행. 전세기 수요를 모아 노선을 엽니다. (상담 신청 · 직접 예약 아님)', cta: '전세기 소식 보기', href: '/jetpool-charter' },
        { key: 'local-life', art: 'seoul', title: 'Local Life', body: '관광지가 아닌 동네의 일상. 현지 프렌드와 걷고, 먹고, 이야기하는 여행.', cta: '가이드 프렌드 만나기', href: '/guide-friends' },
      ] }, { title: 'WONT Travel Club → JETPOOL' }],
    ['STORY', 'local-life-exchange', '한달살기 맞교환 여행', 720,
      '한국인과 외국인이 서로의 집을 바꿔 현지인처럼 살아보는 Local Life — WONT Travel Club의 시작이 된 여행 방식입니다.',
      '## 집을 바꾸면 여행이 달라집니다\n\nWONT Travel Club은 "호텔이 아닌 누군가의 일상에서 한 달을 살아보자"는 작은 모임에서 시작했습니다. 서울의 직장인과 리스본의 일러스트레이터가 서로의 집을 바꿔 한 달을 살았던 첫 맞교환 이후, 수백 가구가 집을 바꿔 살았어요.\n\n## 돈 대신 신뢰를 주고받는 방법\n\n맞교환에는 숙박비가 오가지 않습니다. 대신 양측 본인 인증, 숙소 확인, 전자 약정서 서명을 모두 마쳐야 일정이 확정되고, 두 집의 달력이 동시에 잠깁니다. 한쪽이라도 문제가 생기면 둘 다 확정되지 않아요.\n\n## Local Life\n\n동네 시장에서 장을 보고, 단골 카페를 만들고, 이웃과 인사를 나누는 것. JETPOOL은 WONT Travel Club의 Local Life 정신을 이어 갑니다.',
      { coverUrl: '/art/postcards/lisbon.svg', tags: ['한달살기', '맞교환', 'Local Life'], legacy: { system: 'LEGACY_WONT', id: 'wont-board-1024' } },
      { title: '한달살기 맞교환 여행 — WONT Travel Club', description: '서로의 집을 바꿔 현지인처럼 살아보는 Local Life 여행 이야기.' },
      '한국인과 외국인이 서로의 집을 바꿔 현지인처럼 살아보는 Local Life.'],
    ['STORY', 'seoul-busan-month-swap', '망원동 ↔ 해운대, 한 달 동안 집을 바꿔 살았습니다', 46,
      '서울 망원동 가족과 부산 해운대 부부의 한달살기 맞교환 후기. 시장, 바다, 그리고 서로의 단골집 리스트까지.',
      '## 냉장고에 붙어 있던 단골집 리스트\n\n해운대 집 냉장고에는 손글씨 메모가 붙어 있었습니다. "아침 해장국은 시장 둘째 골목, 비 오는 날엔 달맞이길 카페." 한 달 동안 그 리스트를 하나씩 지워 가는 게 가장 큰 즐거움이었어요.\n\n## 서울의 한 달, 부산의 한 달\n\n부산 부부는 망원시장 떡볶이와 한강 자전거에 빠졌고, 저희 가족은 아침마다 해변을 걸었습니다. 서로의 집에서 지내며 매주 사진을 주고받다 보니 한 달 뒤에는 오래된 친구처럼 느껴졌어요.\n\n## 맞교환을 고민하는 분들께\n\n본인 인증과 약정서 서명까지 마치고 나니 걱정보다 설렘이 컸습니다. 집을 비우기 전 사용 안내 노트 한 장이면 충분해요.',
      { coverUrl: '/art/postcards/busan.svg', tags: ['맞교환 후기', '서울', '부산'] }, { title: '서울↔부산 한달살기 맞교환 후기' }],
    ['STORY', 'jetpool-charter-story', '전세기 공유 JETPOOL은 어떻게 시작됐나', 300,
      'WONT Travel Club 회원들이 함께 띄운 첫 전세기 이야기와, 지금의 사전 수요 접수 방식이 만들어진 이유.',
      '## "우리끼리 비행기 한 대 빌리면 어때요?"\n\n오키나와로 한 달 살기를 떠나려던 회원 몇 명의 농담 같은 대화가 시작이었습니다. 같은 날, 같은 곳으로 떠나고 싶은 사람이 40명을 넘자 여행사와 함께 실제로 전세기를 띄울 수 있었어요.\n\n## 왜 직접 예약이 아니라 수요 접수일까요\n\n전세기는 항공·여행업 인허가가 필요한 영역입니다. JETPOOL은 수요를 모으고, 좌석 판매와 발권은 등록된 여행사가 맡는 방식으로 안전하게 운영합니다.\n\n## 다음 노선은 여러분이 정합니다\n\n가고 싶은 도시와 날짜를 남겨 주세요. 비슷한 수요가 모이면 가장 먼저 소식을 전해 드립니다.',
      { coverUrl: '/art/postcards/coast.svg', tags: ['전세기 공유', 'JETPOOL'], legacy: { system: 'LEGACY_WONT', id: 'wont-board-0877' } }, { title: '전세기 공유 JETPOOL 이야기' }],
    ['STORY', 'local-life-jeonju-alleys', 'Local Life: 전주 골목에서 보낸 일주일', 75,
      '한옥마을을 벗어나 객리단길과 남부시장, 동네 목욕탕까지 — 전주 사람처럼 보낸 7일.',
      '## 관광지 밖의 전주\n\n한옥마을에서 하룻밤을 보낸 뒤, 나머지 엿새는 객리단길 셰어하우스에서 지냈습니다. 아침엔 콩나물국밥, 점심엔 남부시장 순대국밥, 밤엔 청년몰 야시장.\n\n## 동네 해설사와 걷기\n\n자원봉사 해설사 선생님과 경기전 뒤편 골목을 걸으며 한지 공방에 들렀어요. 직접 뜬 한지로 만든 엽서는 지금도 책상 위에 있습니다.\n\n## 일주일이면 단골이 생깁니다\n\n사흘째부터 국숫집 사장님이 "오늘도 왔네" 하며 웃어 주셨어요. Local Life는 그렇게 시작됩니다.',
      { coverUrl: '/art/postcards/gyeongju.svg', tags: ['Local Life', '전주'] }, { title: 'Local Life: 전주 골목 일주일' }],
    ['STORY', 'gangneung-workation', '안목해변 앞 책상에서, 강릉 워케이션 4주 기록', 20,
      '아침엔 바다 산책, 낮엔 원격 근무, 저녁엔 커피 로스터리. 강릉에서 일하며 산 한 달의 루틴을 공유합니다.',
      '## 07:00 바다, 09:00 노트북\n\n창밖으로 바다가 보이는 책상은 생각보다 집중이 잘 됐습니다. 아침 산책 후 커피 한 잔을 내리고 업무를 시작하는 루틴이 자연스럽게 생겼어요.\n\n## 점심은 동네 식당에서\n\n초당 순두부, 장칼국수, 중앙시장 닭강정. 매일 다른 식당을 가도 4주가 모자랐습니다.\n\n## 주말에는 설악산\n\n속초까지 40분이면 닿아요. 일하는 평일과 쉬는 주말이 확실히 나뉘니 오히려 일의 효율이 올랐습니다.',
      { coverUrl: '/art/postcards/gangneung.svg', tags: ['워케이션', '강릉'] }, { title: '강릉 워케이션 4주 기록' }],
    ['STORY', 'jeju-hallim-winter', '귤 따는 겨울, 제주 한림 돌집 한달살기', 150,
      '돌담 마당의 귤나무와 협재 바다, 그리고 동네 삼춘들. 제주 서쪽 마을에서 보낸 겨울 이야기.',
      '## 마당에 귤나무가 있는 집\n\n겨울 제주의 돌집은 생각보다 따뜻했습니다. 온돌을 켜 두고 마당 귤을 따서 바구니에 담아 두는 게 하루의 시작이었어요.\n\n## 협재 바다는 겨울에도 에메랄드빛\n\n바람이 센 날엔 금능 해변 카페에서 책을 읽고, 맑은 날엔 비양도를 바라보며 해안길을 걸었습니다.\n\n## 동네 삼춘들의 귤 선물\n\n한 달이 지나니 옆집 삼춘이 직접 담근 귤청을 건네주셨어요. 이 맛에 한달살기를 합니다.',
      { coverUrl: '/art/postcards/jeju.svg', tags: ['한달살기', '제주'] }, { title: '제주 한림 돌집 한달살기' }],
    ['STORY', 'wont-travel-club-history', 'WONT Travel Club 10년, 그리고 JETPOOL', 400,
      '맞교환 모임에서 전세기 공유, 로컬 가이드 프렌드까지. WONT Travel Club이 JETPOOL로 이어지는 이야기.',
      '## 작은 모임에서 시작했습니다\n\n"원하는(WONT) 곳에서 살아보자." 몇 명의 여행자가 서로의 집을 바꿔 살던 모임이 WONT Travel Club의 시작이었습니다.\n\n## 세 가지 여행\n\n한달살기 맞교환, 전세기 공유, 그리고 현지 친구와 함께하는 Local Life. 지난 시간 동안 회원들이 만들어 온 여행 방식입니다.\n\n## 이제 JETPOOL에서\n\n검증된 숙소 예약과 안전한 결제, 양측 동시 확정 맞교환, 로컬 가이드 프렌드까지. WONT Travel Club의 여행을 더 많은 사람이 안전하게 누릴 수 있도록 JETPOOL로 이어갑니다.',
      { coverUrl: '/art/postcards/city.svg', tags: ['WONT Travel Club', 'JETPOOL'], legacy: { system: 'LEGACY_WONT', id: 'wont-board-0001' } }, { title: 'WONT Travel Club 10년, 그리고 JETPOOL' }],
    ['DESTINATION', 'jeju', '제주', 700, '오름과 바다, 돌담길 사이에서 보내는 한 달 — 한달살기 1위 여행지',
      '## 제주에서 한 달 살기\n\n동쪽의 오름과 해녀 마을, 서쪽의 노을 해안도로, 남쪽 서귀포의 올레길까지. 지역마다 다른 제주의 일상을 골라 살아보세요.\n\n- 추천 동네: 애월, 한림·협재, 서귀포, 세화\n- 함께하면 좋은 경험: 오름 일출 투어, 해녀 체험, 올레길 걷기',
      { lat: 33.4996, lng: 126.5312, region: '제주특별자치도', touristType: ['한달살기', '자연', '워케이션'], art: 'jeju', coverUrl: '/art/postcards/jeju.svg', highlights: ['애월 해안도로', '협재 해변', '성산일출봉'] },
      { title: '제주 한달살기 숙소·가이드·투어', description: '애월·한림·서귀포·세화의 한달살기 숙소와 로컬 가이드, 오름 투어를 한 번에.', og: { image: '/art/postcards/jeju.svg', type: 'place' } },
      '오름, 바다, 돌담길 — 제주에서 한 달 살기.'],
    ['DESTINATION', 'seoul', '서울', 360, '한옥 골목부터 한강 루프탑까지, 동네마다 다른 로컬 라이프',
      '## 동네로 고르는 서울\n\n북촌·서촌의 한옥, 성수의 카페 골목, 망원·연남의 시장과 숲길, 한남의 갤러리, 잠실의 호숫가. 서울은 동네마다 전혀 다른 도시예요.',
      { lat: 37.5665, lng: 126.978, region: '서울특별시', touristType: ['로컬 라이프', '도시', '역사'], art: 'seoul', coverUrl: '/art/postcards/seoul.svg', highlights: ['북촌 한옥마을', '성수동', '망원시장'] },
      { title: '서울 로컬 숙소와 가이드 프렌드', description: '북촌 한옥부터 성수 아파트까지, 서울 동네별 숙소와 로컬 가이드.', og: { image: '/art/postcards/seoul.svg', type: 'place' } }],
    ['DESTINATION', 'busan', '부산', 340, '바다를 보며 일하는 도시, 해운대·광안리 워케이션',
      '## 바다가 일상인 도시\n\n해운대와 광안리의 오션뷰 숙소, 영도 흰여울마을, 기장의 풀빌라까지. 아침엔 해변을 걷고 저녁엔 광안대교 야경을 보세요.',
      { lat: 35.1796, lng: 129.0756, region: '부산광역시', touristType: ['바다', '워케이션', '야경'], art: 'busan', coverUrl: '/art/postcards/busan.svg', highlights: ['광안대교', '흰여울문화마을', '해동용궁사'] },
      { title: '부산 오션뷰 숙소·요트 투어', description: '해운대·광안리·영도·기장 숙소와 선셋 요트 투어.', og: { image: '/art/postcards/busan.svg', type: 'place' } }],
    ['DESTINATION', 'gangneung', '강릉', 330, '커피와 바다, 솔숲 사이의 느린 워케이션',
      '## 커피 도시 강릉\n\n안목 커피거리와 경포호, 초당 순두부 마을. KTX로 서울에서 2시간이면 닿는 바다 워케이션 도시입니다.',
      { lat: 37.7519, lng: 128.8761, region: '강원특별자치도', touristType: ['커피', '바다', '워케이션'], art: 'gangneung', coverUrl: '/art/postcards/gangneung.svg', highlights: ['안목 커피거리', '경포호', '초당 순두부'] },
      { title: '강릉 워케이션 숙소와 커피 투어', description: '안목해변 오션뷰 숙소와 로스터리 트레일.', og: { image: '/art/postcards/gangneung.svg', type: 'place' } }],
    ['DESTINATION', 'gyeongju', '경주', 320, '천년 고도에서의 일상, 한옥과 자전거로 만나는 신라',
      '## 걸어서, 자전거로 만나는 경주\n\n대릉원과 첨성대, 황리단길의 한옥 스테이, 보문호수의 벚꽃길. 도시 전체가 박물관인 경주에서 천천히 머물러 보세요.',
      { lat: 35.8562, lng: 129.2247, region: '경상북도', touristType: ['역사', '한옥', '자전거'], art: 'gyeongju', coverUrl: '/art/postcards/gyeongju.svg', highlights: ['대릉원', '불국사', '보문호수'] },
      { title: '경주 한옥 스테이와 문화 해설', description: '황리단길 한옥, 보문호수 빌라, 역사유적지구 자전거 투어.', og: { image: '/art/postcards/gyeongju.svg', type: 'place' } }],
    ['DESTINATION', 'jeonju', '전주', 300, '한옥마을 골목과 남부시장, 맛의 도시에서 보내는 일주일',
      '## 맛과 한옥의 도시\n\n전주 한옥마을의 고즈넉한 아침, 객리단길의 카페, 남부시장 야시장. 비빔밥 쿠킹 클래스로 전주의 맛을 직접 배워 보세요.',
      { lat: 35.8242, lng: 127.148, region: '전북특별자치도', touristType: ['한옥', '미식', '공예'], art: 'gyeongju', coverUrl: '/art/postcards/gyeongju.svg', highlights: ['전주 한옥마을', '남부시장 야시장', '객리단길'] },
      { title: '전주 한옥마을 숙소와 쿠킹 클래스', description: '한옥마을 숙소, 객리단길 개인실, 비빔밥 쿠킹 클래스.', og: { image: '/art/postcards/gyeongju.svg', type: 'place' } }],
    ['DESTINATION', 'sokcho', '속초', 280, '설악산과 동해가 한 도시에, 산과 바다를 모두 누리는 여행',
      '## 아침엔 산, 저녁엔 바다\n\n울산바위가 보이는 캐빈에서 하루를 시작하고, 영금정 일출과 속초관광수산시장으로 이어지는 여행.',
      { lat: 38.207, lng: 128.5918, region: '강원특별자치도', touristType: ['산', '바다', '미식'], art: 'mountain', coverUrl: '/art/postcards/mountain.svg', highlights: ['설악산 울산바위', '영금정', '아바이마을'] },
      { title: '속초 설악산 뷰 숙소', description: '울산바위가 보이는 캐빈과 동명항 스튜디오.', og: { image: '/art/postcards/mountain.svg', type: 'place' } }],
    ['DESTINATION', 'yeosu', '여수', 260, '여수 밤바다와 돌산대교 야경, 남해안 낭만 여행',
      '## 밤이 아름다운 바다 도시\n\n돌산 오션뷰 테라스, 해상케이블카 크리스탈 캐빈, 낭만포차 거리와 향일암 일출까지.',
      { lat: 34.7604, lng: 127.6622, region: '전라남도', touristType: ['야경', '바다', '미식'], art: 'coast', coverUrl: '/art/postcards/coast.svg', highlights: ['돌산대교', '해상케이블카', '향일암'] },
      { title: '여수 오션뷰 숙소와 해상케이블카', description: '돌산 테라스 하우스와 크리스탈 캐빈 왕복권.', og: { image: '/art/postcards/coast.svg', type: 'place' } }],
    ['FAQ', 'what-is-home-exchange', 'Home Exchange는 무엇인가요?', 700,
      '서로의 집을 일정 기간 교환해 숙박비 없이 여행하는 방식입니다. 양측 검증과 전자 약정 후 확정됩니다.', null,
      { faqs: [
        { question: 'Home Exchange는 무엇인가요?', answer: '서로의 집을 일정 기간 교환해 숙박비 없이 여행하는 방식입니다. 양측 본인 인증과 숙소 확인, 전자 약정서 서명을 마치면 두 집의 일정이 동시에 확정됩니다.' },
        { question: '한쪽만 확정될 수도 있나요?', answer: '아니요. 두 집의 달력은 한 번에 함께 잠기며, 한쪽이라도 실패하면 둘 다 확정되지 않습니다.' },
        { question: '맞교환에도 비용이 드나요?', answer: '맞교환 자체에는 숙박비가 오가지 않습니다. 청소·공과금 등은 약정서의 조건에 따라 각자 부담합니다.' },
      ] }, { title: 'Home Exchange FAQ' },
      '서로의 집을 일정 기간 교환해 숙박비 없이 여행하는 방식입니다. 양측 검증과 전자 약정 후 확정됩니다.'],
    ['FAQ', 'stay-cancellation', '예약을 취소하면 환불은 어떻게 되나요?', 200,
      '숙소마다 정해진 취소 정책(유연·보통·엄격)에 따라 체크인까지 남은 시간으로 환불 비율이 정해집니다.', null,
      { faqs: [
        { question: '취소 정책은 어디서 확인하나요?', answer: '숙소 상세와 결제 화면에 유연·보통·엄격 중 적용 정책과 구간별 환불 비율이 표시됩니다. 예약 시점의 정책이 그대로 적용돼요.' },
        { question: '환불은 언제 들어오나요?', answer: '취소 즉시 환불이 요청되고, 결제사 처리 후 카드사에 따라 3–7영업일 안에 반영됩니다.' },
      ] }, { title: '숙소 취소·환불 FAQ' }],
    ['FAQ', 'address-privacy', '정확한 숙소 주소는 언제 볼 수 있나요?', 190,
      '안전을 위해 정확한 주소는 예약(또는 맞교환)이 확정된 뒤에만 공개되며, 그 전에는 동네 단위의 대략적인 위치만 보여드립니다.', null,
      {}, { title: '숙소 주소 공개 정책' }],
    ['FAQ', 'guide-friend-free', '가이드 프렌드는 정말 무료인가요?', 180,
      '프렌드·자원봉사 가이드는 무료 교류이며, 유료·전문 가이드는 자격 확인을 마친 경우에만 결제가 열립니다.', null,
      { faqs: [
        { question: '프렌드와 자원봉사 가이드는 무료인가요?', answer: '네. 프렌드·자원봉사 가이드는 비용 없이 현지인과 교류하는 프로그램입니다. 식비·입장료 등 실비는 각자 부담해요.' },
        { question: '유료 가이드는 어떻게 검증하나요?', answer: '유료·전문 가이드는 사업자 등록과 자격증 등 승인된 요건을 확인한 뒤에만 유료 예약이 열립니다.' },
      ] }, { title: '가이드 프렌드 FAQ' }],
    ['FAQ', 'charter-booking', '전세기를 바로 예약할 수 있나요?', 170,
      '아니요. 현재 JETPOOL은 전세기 사전 수요 접수와 상담만 진행하며, 좌석 판매와 발권은 노선 확정 후 등록 여행사가 진행합니다.', null,
      {}, { title: '전세기 공유 FAQ' }],
    ['FAQ', 'month-stay-discount', '한달살기 할인은 어떻게 적용되나요?', 160,
      '호스트가 설정한 주간(7박 이상)·월간(28박 이상) 할인이 견적에 자동으로 반영됩니다.', null,
      {}, { title: '장기 숙박 할인 FAQ' }],
  ];
  const cmsId = {};
  for (const [type, slug, title, ago, summary, body, rawData, rawSeo, legacyBody] of CMS) {
    // image hints point at the web app's own art; drop any that no longer exists
    const data = rawData && rawData.coverUrl && !exists(rawData.coverUrl) ? { ...rawData, coverUrl: undefined } : rawData;
    const seo = rawSeo?.og?.image && !exists(rawSeo.og.image) ? { ...rawSeo, og: { ...rawSeo.og, image: undefined } } : rawSeo;
    const r = await one(
      `INSERT INTO cms_entries(id, entry_type, slug, title, summary, body_md, seo, data, status, published_at, author_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PUBLISHED',$9,$10,$9,$9)
       ON CONFLICT (entry_type, slug, locale) DO UPDATE SET summary = EXCLUDED.summary, body_md = EXCLUDED.body_md, seo = EXCLUDED.seo, data = EXCLUDED.data
        WHERE cms_entries.updated_at = cms_entries.created_at AND cms_entries.body_md = $11
       RETURNING id`,
      [uid(`cms:${type}:${slug}`), type, slug, title, summary, body ?? summary, J(seo ?? {}), J(data ?? {}), at(-ago, '10:00'), admin, legacyBody ?? null],
    );
    cmsId[`${type}:${slug}`] = r?.id ?? (await one(`SELECT id FROM cms_entries WHERE entry_type = $1 AND slug = $2 AND locale = 'ko-KR'`, [type, slug])).id;
    if (data?.legacy) {
      await ins('cms_external_refs', `INSERT INTO cms_external_refs(entry_id, system, external_id, source_updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [cmsId[`${type}:${slug}`], data.legacy.system, data.legacy.id, at(-ago - 30, '09:00')]);
    }
  }
  await run(`INSERT INTO seo_redirects(legacy_path, target_path, approved) VALUES ('/localLife','/exchange',true),('/jetpool','/jetpool-charter',true),('/tour','/travel',true) ON CONFLICT DO NOTHING`);
  await run(`INSERT INTO seo_redirects(legacy_path, target_path, approved, source) VALUES
    ('/localLife/apply','/exchange/onboarding',true,'LEGACY_WONT'), ('/board/story','/stories',true,'LEGACY_WONT'),
    ('/board/notice','/stories',true,'LEGACY_WONT'), ('/charter','/jetpool-charter',true,'LEGACY_WONT'), ('/wontclub','/',true,'LEGACY_WONT')
    ON CONFLICT DO NOTHING`);

  // DEV ONLY placeholder rules (NOT legal/tax approval — see G9)
  await db.query(
    `INSERT INTO compliance_rules(id, rule_key, subject_type, jurisdiction, applies_to, required_permit_types, effective_from, status, approved_by, approved_at, note)
     VALUES ($1,'dev-kr-stay','PROPERTY','KR','{}','{}', '2026-01-01','APPROVED',$2, now(),'DEV/STAGING placeholder — replace with legally approved rules before production (G9)')
     ON CONFLICT DO NOTHING`, [uid('rule:compliance:dev'), admin]);
  await db.query(
    `INSERT INTO compliance_rules(id, rule_key, subject_type, jurisdiction, applies_to, required_permit_types, effective_from, status, approved_by, approved_at, note)
     VALUES ($1,'dev-kr-guide-paid','GUIDE','KR','{"guide_type":["PAID","PROFESSIONAL"]}','{BUSINESS_REGISTRATION}', '2026-01-01','APPROVED',$2, now(),'DEV/STAGING placeholder (G9)')
     ON CONFLICT DO NOTHING`, [uid('rule:guide:dev'), admin]);
  for (const [k, type, domain, params] of [
    ['fee-stay', 'PLATFORM_FEE', 'STAY', { bps: 1000 }],
    ['hostfee-stay', 'HOST_FEE', 'STAY', { bps: 300 }],
    ['fee-guide', 'PLATFORM_FEE', 'GUIDE', { bps: 1000 }],
    ['fee-travel', 'PLATFORM_FEE', 'TRAVEL', { bps: 500 }],
    ['vat', 'TAX', '*', { bps: 1000, base: 'PLATFORM_FEE' }],
  ]) {
    await db.query(
      `INSERT INTO finance_rules(id, rule_type, domain, params, effective_from, status, approved_by, approved_at, note)
       VALUES ($1,$2,$3,$4,'2026-01-01','APPROVED',$5, now(),'DEV/STAGING placeholder — requires tax/accounting approval (G9)') ON CONFLICT DO NOTHING`,
      [uid(`rule:finance:${k}`), type, domain, JSON.stringify(params), accountant],
    );
  }
  if (process.env.SEED_ENABLE_FLAGS !== 'false') {
    await db.query(`UPDATE feature_flags SET enabled = true WHERE flag_key IN ('stay.paid_booking','exchange.enabled','guide.paid','travel.commerce','ai.assistant','ai.recommendations','content.auto_translate')`);
  }

  // ================================================================================================ transactions
  // Mirrors the real FSMs (booking/fsm.ts, exchange/service.ts, guide/fsm.ts, travel/service.ts) with matching
  // inventory blocks and state_transitions. A row whose dates are already taken in this database is skipped.
  const FIN = { STAY_FEE: uid('rule:finance:fee-stay'), HOST_FEE: uid('rule:finance:hostfee-stay'), TRAVEL_FEE: uid('rule:finance:fee-travel'), VAT: uid('rule:finance:vat') };
  const RES = {};

  function stayQuote(p, guestId, checkIn, checkOut, guests, quoteId, createdAt) {
    const n = nightsOf(checkIn, checkOut);
    const nights = Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${checkIn}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10), priceMinor: p.price, source: 'BASE', ruleId: null }));
    const nightsTotalMinor = n * p.price;
    const pick = n >= 28 && p.monthly ? ['MONTHLY_DISCOUNT', p.monthly, 'monthly'] : n >= 7 && p.weekly ? ['WEEKLY_DISCOUNT', p.weekly, 'weekly'] : null;
    const discount = pick ? { type: pick[0], bps: pick[1], ruleId: uid(`rate:${p.slug}:${pick[2]}`), amountMinor: applyBps(nightsTotalMinor, pick[1]) } : null;
    const discountMinor = discount?.amountMinor ?? 0;
    const subtotalMinor = nightsTotalMinor - discountMinor;
    const base = subtotalMinor + p.cleaning;
    const platformFeeMinor = applyBps(base, 1000);
    const hostFeeMinor = applyBps(base, 300);
    const taxMinor = applyBps(platformFeeMinor, 1000);
    const totalMinor = base + platformFeeMinor + taxMinor;
    const rulesVersion = { pricing: 'booking-pricing-v1', finance: { PLATFORM_FEE: FIN.STAY_FEE, HOST_FEE: FIN.HOST_FEE, TAX: FIN.VAT }, rateRules: discount ? [discount.ruleId] : [] };
    const breakdown = { nightsCount: n, nights, nightsTotalMinor, extraGuestFeeMinor: 0, extraGuest: null, discount, discountMinor, subtotalMinor, cleaningFeeMinor: p.cleaning,
      platformFeeMinor, taxMinor, hostFeeMinor, totalMinor, currency: 'KRW', rulesVersion };
    const expiresAt = plusMin(createdAt, 15);
    const snapshot = { id: quoteId, propertyId: p.id, guestId, checkIn, checkOut, guests, nights: n, subtotalMinor, cleaningFeeMinor: p.cleaning, platformFeeMinor, taxMinor,
      discountMinor, totalMinor, currency: 'KRW', breakdown, rulesVersion, expiresAt, createdAt, hostFeeMinor };
    return { n, subtotalMinor, platformFeeMinor, taxMinor, discountMinor, totalMinor, breakdown, rulesVersion, expiresAt, snapshot };
  }

  /** A paid stay: quote → hold (CONVERTED) → RESERVATION block → reservation (+ history). No payment row (DEV rule). */
  async function stay(key, { slug, guestId, checkIn, checkOut, guests, status, bookedAt, message }) {
    const p = PROP[slug];
    const id = uid(`reservation:${key}`);
    const existing = await one(`SELECT code, check_in::text AS check_in, check_out::text AS check_out, confirmed_at, completed_at, total_minor FROM reservations WHERE id = $1`, [id]);
    if (existing) {
      RES[key] = { id, code: existing.code, slug, guestId, hostId: p.hostId, checkIn: existing.check_in, checkOut: existing.check_out,
        confirmedAt: existing.confirmed_at?.toISOString?.() ?? existing.confirmed_at, completedAt: existing.completed_at, totalMinor: Number(existing.total_minor) };
      return id;
    }
    const blockId = uid(`block:reservation:${key}`);
    if (!(await rangeFree(p.id, checkIn, checkOut, [blockId]))) { skipped.push(`stay ${key} (${slug} ${checkIn}..${checkOut} already taken)`); return null; }
    const quoteId = uid(`quote:${key}`);
    const holdId = uid(`hold:${key}`);
    const qt = stayQuote(p, guestId, checkIn, checkOut, guests, quoteId, bookedAt);
    await ins('booking_quotes', `INSERT INTO booking_quotes(id, property_id, guest_id, check_in, check_out, guests, subtotal_minor, cleaning_fee_minor, platform_fee_minor, tax_minor,
        discount_minor, total_minor, currency, breakdown, rules_version, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'KRW',$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
      [quoteId, p.id, guestId, checkIn, checkOut, guests, qt.subtotalMinor, p.cleaning, qt.platformFeeMinor, qt.taxMinor, qt.discountMinor, qt.totalMinor, J(qt.breakdown), J(qt.rulesVersion), qt.expiresAt, bookedAt]);
    await block(blockId, p.id, checkIn, checkOut, 'RESERVATION', 'RESERVATION', id, guestId, null, bookedAt);
    await ins('reservation_holds', `INSERT INTO reservation_holds(id, quote_id, property_id, inventory_block_id, guest_id, status, expires_at, created_at)
      VALUES ($1,$2,$3,$4,$5,'CONVERTED',$6,$7) ON CONFLICT DO NOTHING`, [holdId, quoteId, p.id, blockId, guestId, qt.expiresAt, bookedAt]);
    const pol = policies[p.policy];
    const policySnapshot = { id: pol.id, code: pol.code, name: pol.name, tiers: pol.tiers, service_fee_refundable: pol.service_fee_refundable, timezone: 'Asia/Seoul', checkInTime: '15:00:00', capturedAt: bookedAt };
    const confirmedAt = plusMin(bookedAt, 3);
    const checkedInAt = status === 'COMPLETED' ? `${checkIn}T15:40:00+09:00` : null;
    const completedAt = status === 'COMPLETED' ? `${checkOut}T00:20:00+09:00` : null;
    await ins('reservations', `INSERT INTO reservations(id, code, property_id, host_id, guest_id, hold_id, quote_id, inventory_block_id, status, check_in, check_out, guests,
        total_minor, currency, quote_snapshot, cancellation_policy_snapshot, guest_message, confirmed_at, checked_in_at, completed_at, version, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'KRW',$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT DO NOTHING`,
      [id, codeFor(`reservation:${key}`), p.id, p.hostId, guestId, holdId, quoteId, blockId, status, checkIn, checkOut, guests, qt.totalMinor, J(qt.snapshot), J(policySnapshot),
        message ?? null, confirmedAt, checkedInAt, completedAt, status === 'COMPLETED' ? 6 : 4, bookedAt, completedAt ?? confirmedAt]);
    const meta = { quoteId, holdId };
    await history('RESERVATION', id, [
      [null, 'DRAFT', bookedAt, guestId, 'USER', 'reservation created', meta],
      ['DRAFT', 'QUOTED', bookedAt, guestId, 'USER', 'quote attached', meta],
      ['QUOTED', 'HELD', bookedAt, guestId, 'USER', 'inventory hold acquired', { ...meta, blockId }],
      ['HELD', 'PAYMENT_PENDING', plusMin(bookedAt, 1), guestId, 'USER', 'payment created'],
      ['PAYMENT_PENDING', 'CONFIRMED', confirmedAt, null, 'PROVIDER', 'DEV seed: confirmed without a payment record (no ledger)', { amountMinor: qt.totalMinor, currency: 'KRW' }],
      ...(status === 'COMPLETED' ? [
        ['CONFIRMED', 'CHECKED_IN', checkedInAt, guestId, 'USER', 'checked in'],
        ['CHECKED_IN', 'COMPLETED', completedAt, null, 'SYSTEM', 'auto-completed after check-out'],
      ] : []),
    ]);
    await history('RESERVATION_HOLD', holdId, [['ACTIVE', 'CONVERTED', confirmedAt, null, 'PROVIDER', 'payment approved']]);
    RES[key] = { id, code: codeFor(`reservation:${key}`), slug, guestId, hostId: p.hostId, checkIn, checkOut, confirmedAt, completedAt, totalMinor: qt.totalMinor };
    return id;
  }

  async function review(key, { authorId, targetType, targetId, txType, txId, rating, body, createdAt, sub, response, responderId }) {
    const id = uid(`review:${key}`);
    await ins('reviews', `INSERT INTO reviews(id, author_id, target_type, target_id, transaction_type, transaction_id, rating, sub_ratings, body, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PUBLISHED',$10,$10) ON CONFLICT DO NOTHING`, [id, authorId, targetType, targetId, txType, txId, rating, J(sub ?? {}), body, createdAt]);
    if (response && responderId) {
      await ins('review_responses', `INSERT INTO review_responses(review_id, author_id, body, created_at)
        SELECT $1::uuid, $2::uuid, $3::text, $4::timestamptz WHERE EXISTS (SELECT 1 FROM reviews WHERE id = $1::uuid) ON CONFLICT DO NOTHING`,
        [id, responderId, response, plusMin(createdAt, 18 * 60)]);
    }
    return id;
  }
  const subRatings = (rating, i) => {
    const keys = ['cleanliness', 'accuracy', 'communication', 'location', 'checkin', 'value'];
    return Object.fromEntries(keys.map((k, j) => [k, Math.max(3, Math.min(5, rating - ((i + j) % 5 === 0 && rating > 3 ? 1 : 0)))]));
  };

  // ---- completed stays + reviews
  for (const [i, [slug, reviewer, rating, body, endAgo, nights, reply]] of STAY_REVIEWS.entries()) {
    const key = `past:${slug}:${reviewer}`;
    const checkOut = day(-endAgo);
    const checkIn = day(-endAgo - nights);
    const resId = await stay(key, { slug, guestId: U[reviewer], checkIn, checkOut, guests: Math.min(PROP[slug].guests, 1 + (i % 3)), status: 'COMPLETED', bookedAt: at(-endAgo - nights - 12 - (i % 9), '21:10') });
    if (!resId) continue;
    const p = PROP[slug];
    const createdAt = at(-endAgo + 1, '20:30');
    await review(`property:${key}`, { authorId: U[reviewer], targetType: 'PROPERTY', targetId: p.id, txType: 'RESERVATION', txId: resId, rating, body, createdAt, sub: subRatings(rating, i), response: reply, responderId: p.hostId });
    const english = /^[A-Za-z]/.test(body);
    const hostBodies = english ? HOST_REVIEW_BODY.en : HOST_REVIEW_BODY.ko;
    await review(`host:${key}`, { authorId: U[reviewer], targetType: 'HOST', targetId: p.hostId, txType: 'RESERVATION', txId: resId, rating: Math.max(rating, 4), body: hostBodies[i % hostBodies.length], createdAt: plusMin(createdAt, 2) });
    if (reviewer === 'guest' && GUEST_REVIEWS[slug]) {
      const [r, b] = GUEST_REVIEWS[slug];
      await review(`guest:${key}`, { authorId: p.hostId, targetType: 'GUEST', targetId: guest, txType: 'RESERVATION', txId: resId, rating: r, body: b, createdAt: at(-endAgo + 2, '11:00') });
    }
  }
  // the guest's most recent stay: completed, not reviewed yet (shows up as a pending review task)
  await stay('guest-gwangalli-recent', { slug: 'busan-gwangalli-ocean', guestId: guest, checkIn: day(-6), checkOut: day(-3), guests: 2, status: 'COMPLETED', bookedAt: at(-21, '22:05'), message: '부산 출장 겸 여행이에요. 짐을 일찍 맡길 수 있을까요?' });
  // upcoming confirmed stays
  for (const [key, slug, who, inDays, nights, guests, bookedAgo, message] of UPCOMING_STAYS) {
    await stay(`upcoming:${key}`, { slug, guestId: U[who], checkIn: day(inDays), checkOut: day(inDays + nights), guests, status: 'CONFIRMED', bookedAt: at(-bookedAgo, '21:14'), message });
  }

  // ---- Home Exchanges
  const termsDoc = await one(`SELECT version, title, body_md FROM consent_documents WHERE consent_type = 'EXCHANGE_TERMS' ORDER BY published_at DESC NULLS LAST, version DESC LIMIT 1`);
  const EX = {};
  async function homeSnapshot(propertyId) {
    const pr = await one(`SELECT title, check_in_time::text AS check_in_time, check_out_time::text AS check_out_time FROM properties WHERE id = $1`, [propertyId]);
    const rules = await one(`SELECT smoking_allowed, pets_allowed, events_allowed, quiet_hours, extra_rules FROM house_rules WHERE property_id = $1`, [propertyId]);
    return { propertyId, title: pr?.title ?? null, checkInTime: pr?.check_in_time ?? null, checkOutTime: pr?.check_out_time ?? null, houseRules: rules };
  }
  /**
   * offers: [{ by, start, end, guestsA, guestsB, terms, message, at }]; dates are the same for both homes (simultaneous swap).
   * steps: lifecycle timestamps for the statuses after the last offer.
   */
  async function exchange(key, { requester, responder, homeA, homeB, offers, status, steps = {}, conversation }) {
    const id = uid(`exchange:${key}`);
    const pa = PROP[homeA], pb = PROP[homeB];
    const last = offers[offers.length - 1];
    if (await one(`SELECT 1 FROM exchange_requests WHERE id = $1`, [id])) {
      EX[key] = { id, requester, responder, homeA, homeB, start: last.start, end: last.end };
      return id;
    }
    const blocked = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(status);
    const blockA = uid(`block:exchange:${key}:A`), blockB = uid(`block:exchange:${key}:B`);
    if (blocked && (!(await rangeFree(pa.id, last.start, last.end, [blockA])) || !(await rangeFree(pb.id, last.start, last.end, [blockB])))) {
      skipped.push(`exchange ${key} (dates taken)`);
      return null;
    }
    const v = offers.length;
    const convId = uid(`conversation:exchange:${key}`);
    const lastBy = last.by === 'A' ? requester : responder;
    const accA = status === 'COUNTERED' || status === 'REQUESTED' ? (last.by === 'A' ? v : v - 1) : v;
    const accB = status === 'COUNTERED' || status === 'REQUESTED' ? (last.by === 'B' ? v : null) : v;
    const range = `[${last.start},${last.end})`;
    await ins('exchange_requests', `INSERT INTO exchange_requests(id, requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status, current_offer_version,
        last_offer_by, accepted_a_version, accepted_b_version, conversation_id, version, respond_by, confirmed_at, started_at, completed_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::daterange,$6::daterange,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING`,
      [id, requester, responder, pa.id, pb.id, range, status, v, lastBy, accA, accB, conversation ? convId : null, 1 + Object.keys(steps).length + (v - 1),
        ['REQUESTED', 'COUNTERED'].includes(status) ? plusMin(last.at, 7 * 24 * 60) : null, steps.CONFIRMED ?? null, steps.IN_PROGRESS ?? null, steps.COMPLETED ?? null,
        offers[0].at, steps.REVIEWED ?? steps.COMPLETED ?? steps.IN_PROGRESS ?? steps.CONFIRMED ?? last.at]);
    for (const [i, o] of offers.entries()) {
      await ins('exchange_offers', `INSERT INTO exchange_offers(id, exchange_id, version, created_by, dates_a, dates_b, guests_a, guests_b, terms, message, created_at)
        VALUES ($1,$2,$3,$4,$5::daterange,$5::daterange,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [uid(`exchange-offer:${key}:${i + 1}`), id, i + 1, o.by === 'A' ? requester : responder, `[${o.start},${o.end})`, o.guestsA, o.guestsB, J(o.terms ?? {}), o.message ?? null, o.at]);
    }
    const hist = [[null, 'REQUESTED', offers[0].at, requester, 'USER', 'exchange requested']];
    let prev = 'REQUESTED';
    for (const [i, o] of offers.slice(1).entries()) {
      hist.push([prev, 'COUNTERED', o.at, o.by === 'A' ? requester : responder, 'USER', `counter offer v${i + 2}`, { offerVersion: i + 2 }]);
      prev = 'COUNTERED';
    }
    if (steps.MUTUAL_ACCEPTED) {
      hist.push([prev, 'MUTUAL_ACCEPTED', steps.MUTUAL_ACCEPTED, responder, 'USER', `both parties accepted offer v${v}`, { offerVersion: v }]);
      hist.push(['MUTUAL_ACCEPTED', 'VERIFICATION_PENDING', steps.MUTUAL_ACCEPTED, null, 'SYSTEM', 'verification gate opened']);
      hist.push(['VERIFICATION_PENDING', 'AGREEMENT_PENDING', steps.AGREEMENT_PENDING, null, 'SYSTEM', 'all verification checks passed']);
    }
    if (steps.CONFIRMED) hist.push(['AGREEMENT_PENDING', 'CONFIRMED', steps.CONFIRMED, requester, 'USER', 'both homes blocked atomically', { blockIds: [blockA, blockB].sort() }]);
    if (steps.IN_PROGRESS) hist.push(['CONFIRMED', 'IN_PROGRESS', steps.IN_PROGRESS, null, 'SYSTEM', 'earliest stay started']);
    if (steps.COMPLETED) hist.push(['IN_PROGRESS', 'COMPLETED', steps.COMPLETED, null, 'SYSTEM', 'both stays ended']);
    if (steps.REVIEWED) hist.push(['COMPLETED', 'REVIEWED', steps.REVIEWED, null, 'SYSTEM', 'bilateral reviews completed']);
    await history('EXCHANGE', id, hist);
    if (steps.MUTUAL_ACCEPTED) {
      for (const [party, home] of [[requester, pa], [responder, pb]]) {
        for (const check of ['IDENTITY', 'PROPERTY', 'SAFETY_ACK']) {
          const detail = check === 'IDENTITY' ? { failures: [] } : check === 'PROPERTY' ? { propertyId: home.id, failures: [] } : { acknowledgedAt: steps.AGREEMENT_PENDING, ip: null, userAgent: 'seed-dev' };
          await ins('exchange_verifications', `INSERT INTO exchange_verifications(id, exchange_id, party_user_id, check_type, status, detail, checked_at) VALUES ($1,$2,$3,$4,'PASSED',$5,$6) ON CONFLICT DO NOTHING`,
            [uid(`exchange-check:${key}:${party}:${check}`), id, party, check, J(detail), steps.AGREEMENT_PENDING]);
        }
      }
      const snapshot = {
        schema: 'jetpool.exchange.agreement/v1', exchangeId: id, offerVersion: v,
        offer: { datesA: { start: last.start, end: last.end }, datesB: { start: last.start, end: last.end }, guestsA: last.guestsA, guestsB: last.guestsB, terms: last.terms ?? {}, createdBy: last.by === 'A' ? requester : responder },
        parties: { requester: { userId: requester, propertyId: pa.id }, responder: { userId: responder, propertyId: pb.id } },
        homes: { A: await homeSnapshot(pa.id), B: await homeSnapshot(pb.id) },
        platformTerms: { type: 'EXCHANGE_TERMS', version: termsDoc.version, title: termsDoc.title, bodySha256: sha256(termsDoc.body_md) },
      };
      const termsHash = sha256(canonicalJson(snapshot));
      const signed = !!steps.CONFIRMED;
      const evidence = (when) => ({ termsHash, termsVersion: termsDoc.version, offerVersion: v, signedAt: when, ip: null, userAgent: 'seed-dev', sessionId: null, correlationId: `seed-dev:exchange:${id.slice(0, 8)}` });
      const signA = signed ? plusMin(steps.AGREEMENT_PENDING, 90) : null, signB = signed ? plusMin(steps.AGREEMENT_PENDING, 240) : null;
      await ins('exchange_agreements', `INSERT INTO exchange_agreements(id, exchange_id, terms_version, terms_snapshot, terms_hash, offer_version, accepted_a_at, accepted_a_evidence,
          accepted_b_at, accepted_b_evidence, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [uid(`exchange-agreement:${key}`), id, termsDoc.version, J(snapshot), termsHash, v, signA, signA ? J(evidence(signA)) : null, signB, signB ? J(evidence(signB)) : null,
          signed ? 'SIGNED' : 'PENDING', steps.AGREEMENT_PENDING]);
    }
    if (blocked) {
      await block(blockA, pa.id, last.start, last.end, 'EXCHANGE', 'EXCHANGE', id, requester, `exchange ${id} home A`, steps.CONFIRMED);
      await block(blockB, pb.id, last.start, last.end, 'EXCHANGE', 'EXCHANGE', id, requester, `exchange ${id} home B`, steps.CONFIRMED);
    }
    if (conversation) {
      await converse(`exchange:${key}`, convId, { contextType: 'EXCHANGE', contextId: id, createdBy: requester, members: [[requester, 'REQUESTER', conversation.readA], [responder, 'RESPONDER', conversation.readB]], messages: conversation.messages });
    }
    EX[key] = { id, requester, responder, homeA, homeB, start: last.start, end: last.end };
    return id;
  }

  /** members: [[userId, role, lastReadAt]]; messages: [[senderId|null, body, at]] (sender null = SYSTEM). */
  async function converse(key, id, { contextType, contextId, createdBy, members, messages }) {
    const lastAt = messages.length ? messages[messages.length - 1][2] : null;
    await ins('conversations', `INSERT INTO conversations(id, context_type, context_id, created_by, last_message_at, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [id, contextType, contextId, createdBy, lastAt, messages[0]?.[2] ?? hoursAgo(24)]);
    const conv = await one(`SELECT id FROM conversations WHERE id = $1`, [id]);
    if (!conv) { skipped.push(`conversation ${key} (context already has a conversation)`); return null; }
    for (const [userId, role, readAt] of members) {
      await ins('conversation_members', `INSERT INTO conversation_members(conversation_id, user_id, role, last_read_at, joined_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [id, userId, role, readAt ?? null, messages[0]?.[2] ?? hoursAgo(24)]);
    }
    for (const [i, [senderId, body, when]] of messages.entries()) {
      await ins('messages', `INSERT INTO messages(id, conversation_id, sender_id, type, body, client_message_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [uid(`message:${key}:${i}`), id, senderId, senderId ? 'TEXT' : 'SYSTEM', body, `seed-${codeFor(`${key}:${i}`, 12).toLowerCase()}`, when]);
    }
    return id;
  }

  const swapTerms = { cleaning: '각자 퇴실 전 기본 청소', utilities: '공과금은 각자 부담', carIncluded: false, petCare: false };
  await exchange('countered-busan-mangwon', {
    requester: exchanger, responder: hostA, homeA: 'busan-home', homeB: 'seoul-mangwon-house', status: 'COUNTERED',
    offers: [
      { by: 'A', start: day(150), end: day(164), guestsA: 3, guestsB: 2, terms: swapTerms, at: at(-4, '20:12'), message: '안녕하세요! 저희 부부가 서울에서 2주 지내고 싶어 망원동 집에 맞교환을 요청드려요. 해운대 집은 바다까지 걸어서 5분이에요.' },
      { by: 'B', start: day(157), end: day(171), guestsA: 3, guestsB: 2, terms: { ...swapTerms, carIncluded: true }, at: at(-1, '09:40'), message: '반가워요! 아이 학교 일정 때문에 일주일 늦춰서 다시 제안드려요. 대신 저희 차도 쓰셔도 됩니다.' },
    ],
    conversation: {
      readA: at(-3, '08:00'), readB: at(-1, '09:41'),
      messages: [
        [exchanger, '안녕하세요! 저희 부부가 서울에서 2주 지내고 싶어 망원동 집에 맞교환을 요청드려요. 해운대 집은 바다까지 걸어서 5분이에요.', at(-4, '20:12')],
        [hostA, '반가워요! 해운대 집 사진 잘 봤어요. 아이들이 바다를 정말 좋아할 것 같아요.', at(-3, '07:55')],
        [hostA, '아이 학교 일정 때문에 일주일 늦춰서 다시 제안드렸어요. 대신 저희 차도 쓰셔도 됩니다.', at(-1, '09:40')],
        [null, '새 제안(v2)이 도착했습니다. 일정과 조건을 확인한 뒤 수락하거나 다시 제안해 주세요.', at(-1, '09:41')],
      ],
    },
  });
  await exchange('confirmed-busan-jamsil', {
    requester: exchanger, responder: hostA, homeA: 'busan-home', homeB: 'seoul-jamsil-apt', status: 'CONFIRMED',
    offers: [{ by: 'A', start: day(45), end: day(59), guestsA: 2, guestsB: 3, terms: swapTerms, at: at(-30, '21:30'), message: '석촌호수 뷰 아파트와 2주 맞교환하고 싶어요. 저희는 조용한 2인 가족입니다.' }],
    steps: { MUTUAL_ACCEPTED: at(-28, '10:05'), AGREEMENT_PENDING: at(-27, '19:20'), CONFIRMED: at(-26, '22:10') },
    conversation: {
      readA: at(-3, '12:00'), readB: at(-3, '12:05'),
      messages: [
        [exchanger, '석촌호수 뷰 아파트와 2주 맞교환하고 싶어요. 저희는 조용한 2인 가족입니다.', at(-30, '21:30')],
        [hostA, '좋아요! 아이들 방은 그대로 두고 갈게요. 해운대 집 사용 안내도 부탁드려요.', at(-28, '10:04')],
        [null, '양쪽 숙소 일정이 동시에 확정되었습니다. 정확한 주소가 공개되었어요.', at(-26, '22:10')],
        [exchanger, '열쇠는 관리실에 맡겨 둘게요. 분리수거 요일은 화·금이에요!', at(-3, '11:50')],
        [hostA, '감사합니다. 저희도 냉장고에 동네 맛집 리스트 붙여 둘게요 :)', at(-3, '12:05')],
      ],
    },
  });
  const exReviewed = await exchange('reviewed-hallim-busan', {
    requester: hostB, responder: exchanger, homeA: 'jeju-hallim-stone-house', homeB: 'busan-home', status: 'REVIEWED',
    offers: [{ by: 'A', start: day(-160), end: day(-146), guestsA: 2, guestsB: 2, terms: swapTerms, at: at(-210, '20:00'), message: '한림 돌집과 해운대 집, 2주 맞교환 어떠세요?' }],
    steps: { MUTUAL_ACCEPTED: at(-208, '09:00'), AGREEMENT_PENDING: at(-207, '18:00'), CONFIRMED: at(-206, '21:00'), IN_PROGRESS: at(-160, '00:10'), COMPLETED: at(-146, '00:10'), REVIEWED: at(-143, '10:00') },
    conversation: {
      readA: at(-143, '10:00'), readB: at(-143, '10:00'),
      messages: [
        [hostB, '한림 돌집과 해운대 집, 2주 맞교환 어떠세요?', at(-210, '20:00')],
        [exchanger, '제주 돌집이라니 너무 좋아요! 바로 수락할게요.', at(-208, '08:58')],
        [exchanger, '덕분에 제주에서 꿈같은 2주를 보냈어요. 후기 남겼습니다!', at(-145, '19:00')],
      ],
    },
  });
  if (exReviewed) {
    await review('exchange:reviewed-hallim-busan:A', { authorId: hostB, targetType: 'EXCHANGE_PARTNER', targetId: exchanger, txType: 'EXCHANGE', txId: exReviewed, rating: 5, body: '집을 아껴 써 주시고 화분까지 챙겨 주셨어요. 최고의 교환 파트너!', createdAt: at(-145, '10:00') });
    await review('exchange:reviewed-hallim-busan:B', { authorId: exchanger, targetType: 'EXCHANGE_PARTNER', targetId: hostB, txType: 'EXCHANGE', txId: exReviewed, rating: 5, body: '돌집 사용 안내가 꼼꼼해서 처음인데도 편했어요. 귤도 감사합니다!', createdAt: at(-144, '21:00') });
  }

  // ---- guide bookings
  async function guideBooking(key, { guideKey, travelerId, startAt, endAt, status, at: createdAt, request, withConversation = false }) {
    const g = GUIDES.find((x) => x.key === guideKey);
    const gid = U[guideKey];
    const id = uid(`guide-booking:${key}`);
    const convId = withConversation ? uid(`conversation:guide-booking:${key}`) : null;
    if (await one(`SELECT 1 FROM guide_bookings WHERE id = $1`, [id])) return { id, convId, gid };
    const active = ['ACCEPTED', 'PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS'].includes(status);
    if (active && (await one(`SELECT 1 FROM guide_bookings WHERE guide_id = $1 AND status IN ('ACCEPTED','PAYMENT_PENDING','CONFIRMED','IN_PROGRESS')
        AND tstzrange(start_at, end_at) && tstzrange($2::timestamptz, $3::timestamptz) LIMIT 1`, [gid, startAt, endAt]))) {
      skipped.push(`guide booking ${key} (guide already booked)`);
      return null;
    }
    const paid = g.type === 'PAID' || g.type === 'PROFESSIONAL';
    const hours = (Date.parse(endAt) - Date.parse(startAt)) / 3600_000;
    const price = paid ? Math.round(g.hourly * hours) : 0;
    let requestId = null, offerId = null;
    if (request) {
      requestId = uid(`guide-request:${key}`);
      offerId = uid(`guide-offer:${key}`);
      await ins('guide_requests', `INSERT INTO guide_requests(id, traveler_id, guide_id, start_at, end_at, party_size, city, languages, interests, message, status, current_offer_version, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACCEPTED',1,$11) ON CONFLICT DO NOTHING`,
        [requestId, travelerId, gid, startAt, endAt, request.partySize, g.city, request.languages, request.interests, request.message, createdAt]);
      await ins('guide_offers', `INSERT INTO guide_offers(id, request_id, version, created_by, start_at, end_at, paid, price_minor, itinerary, status, created_at)
        VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,'ACCEPTED',$9) ON CONFLICT DO NOTHING`, [offerId, requestId, gid, startAt, endAt, paid, price, request.itinerary, plusMin(createdAt, 600)]);
      await history('GUIDE_REQUEST', requestId, [
        ['REQUESTED', 'OFFERED', plusMin(createdAt, 600), gid, 'USER', 'offer v1', { offerVersion: 1 }],
        ['OFFERED', 'ACCEPTED', plusMin(createdAt, 900), travelerId, 'USER', 'accepted v1', { offerVersion: 1 }],
      ]);
    }
    const bookedAt = request ? plusMin(createdAt, 900) : createdAt;
    await ins('guide_bookings', `INSERT INTO guide_bookings(id, request_id, offer_id, guide_id, traveler_id, guide_type, start_at, end_at, status, paid, price_minor, currency, conversation_id, version, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'KRW',$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
      [id, requestId, offerId, gid, travelerId, g.type, startAt, endAt, status, paid, price, convId, { CONFIRMED: 2, REVIEWED: 5 }[status] ?? 1, bookedAt,
        status === 'REVIEWED' ? plusMin(endAt, 26 * 60) : plusMin(bookedAt, 1)]);
    const steps = [[null, 'ACCEPTED', bookedAt, travelerId, 'USER', 'offer accepted', offerId ? { offerId } : {}]];
    if (paid) {
      steps.push(['ACCEPTED', 'PAYMENT_PENDING', plusMin(bookedAt, 1), travelerId, 'USER', 'payment created']);
      steps.push(['PAYMENT_PENDING', 'CONFIRMED', plusMin(bookedAt, 2), null, 'PROVIDER', 'DEV seed: confirmed without a payment record (no ledger)']);
    } else {
      steps.push(['ACCEPTED', 'CONFIRMED', bookedAt, travelerId, 'USER', 'free booking confirmed on acceptance']);
    }
    if (status === 'REVIEWED') {
      steps.push(['CONFIRMED', 'IN_PROGRESS', startAt, null, 'SYSTEM', 'scheduled start']);
      steps.push(['IN_PROGRESS', 'COMPLETED', plusMin(endAt, 120), null, 'SYSTEM', 'auto-completed after end + grace']);
      steps.push(['COMPLETED', 'REVIEWED', plusMin(endAt, 26 * 60), null, 'SYSTEM', 'reviewed by traveler']);
    }
    await history('GUIDE_BOOKING', id, steps);
    return { id, convId, gid, price };
  }

  for (const [i, [guideKey, who, ago, start, end, rating, body]] of GUIDE_REVIEWS.entries()) {
    const key = `past:${guideKey}:${who}`;
    const b = await guideBooking(key, { guideKey, travelerId: U[who], startAt: at(-ago, start), endAt: at(-ago, end), status: 'REVIEWED', at: at(-ago - 10 - (i % 6), '20:00') });
    if (b?.id) {
      await review(`guide:${key}`, { authorId: U[who], targetType: 'GUIDE', targetId: U[guideKey], txType: 'GUIDE_BOOKING', txId: b.id, rating, body, createdAt: plusMin(at(-ago, end), 25 * 60) });
    }
  }
  const minaBooking = await guideBooking('upcoming:guest-mina', {
    guideKey: 'guide-friend', travelerId: guest, startAt: at(14, '14:00'), endAt: at(14, '17:00'), status: 'CONFIRMED', at: at(-6, '19:30'), withConversation: true,
    request: { partySize: 2, languages: ['ko', 'en'], interests: ['cafe', 'walking'], message: '성수동 카페 골목이랑 서울숲 산책을 좋아해요. 친구 한 명과 함께 가요!',
      itinerary: '14:00 성수역 3번 출구 → 카페 골목 → 수제화 거리 → 서울숲 산책 → 17:00 뚝섬 한강공원 노을' },
  });
  if (minaBooking?.id) {
    await converse('guide-booking:guest-mina', minaBooking.convId, {
      contextType: 'GUIDE_BOOKING', contextId: minaBooking.id, createdBy: guest,
      members: [[guest, 'TRAVELER', at(-5, '08:00')], [guideFriend, 'GUIDE', at(-5, '07:40')]],
      messages: [
        [null, '가이드 일정이 확정되었습니다. 만나는 장소와 시간을 확인해 주세요.', at(-5, '10:00')],
        [guest, '확정 감사해요! 친구 한 명이랑 같이 갈게요. 카페 두세 곳 정도 들르면 좋겠어요.', at(-5, '10:20')],
        [guideFriend, '좋아요! 성수역 3번 출구에서 만나요. 많이 걸으니까 편한 신발 신고 오세요 👟', at(-5, '12:03')],
      ],
    });
  }

  // ---- travel orders (no payment rows: DEV rule)
  async function pastDeparture(slug, ago) {
    const p = PRODUCT[slug];
    const id = uid(`departure:${slug}:past:${ago}`);
    const startsAt = at(-ago, p.time);
    const created = await ins('travel_departures', `INSERT INTO travel_departures(id, product_id, starts_at, ends_at, capacity, min_participants, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'DEPARTED',$7) ON CONFLICT DO NOTHING`, [id, p.id, startsAt, plusMin(startsAt, p.minutes), p.capacity, p.min, at(-ago - 40, '10:00')]);
    if (created) await history('travel_departure', id, [['OPEN', 'DEPARTED', startsAt, null, 'SYSTEM', 'STARTED']]);
    return id;
  }
  async function order(key, { buyerId, slug, departureId, qty, status, at: createdAt, departAt }) {
    const p = PRODUCT[slug];
    const id = uid(`order:${key}`);
    const existing = await one(`SELECT code, total_minor FROM orders WHERE id = $1`, [id]);
    if (existing) return { id, code: existing.code, total: Number(existing.total_minor) };
    const subtotal = p.price * qty;
    const platformFeeMinor = applyBps(subtotal, 500);
    const taxMinor = applyBps(platformFeeMinor, 1000);
    const total = subtotal + platformFeeMinor + taxMinor;
    const pricing = {
      subtotalMinor: subtotal, platformFeeMinor, taxMinor, totalMinor: total, rulesVersion: { PLATFORM_FEE: FIN.TRAVEL_FEE, TAX: FIN.VAT },
      suppliers: [{ supplierId, payeeId: supplierUser, supplierName: 'WONT Travel Club Tours', grossMinor: subtotal, commissionBps: 1500, commissionMinor: applyBps(subtotal, 1500) }],
      cancellationTerms: { [p.id]: p.terms }, quotedAt: createdAt,
    };
    const paidAt = plusMin(createdAt, 3);
    const fulfilledAt = status === 'FULFILLED' ? plusMin(departAt, p.minutes) : null;
    await ins('orders', `INSERT INTO orders(id, code, buyer_id, status, currency, subtotal_minor, fee_minor, total_minor, merchant_of_record, expires_at, pricing_snapshot, fulfilled_at, version, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'KRW',$5,$6,$7,'JETPOOL',NULL,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [id, codeFor(`order:${key}`), buyerId, status, subtotal, platformFeeMinor + taxMinor, total, J(pricing), fulfilledAt, status === 'FULFILLED' ? 4 : 3, createdAt, fulfilledAt ?? paidAt]);
    const itemId = uid(`order-item:${key}`);
    if (await ins('order_items', `INSERT INTO order_items(id, order_id, sellable_type, sellable_id, supplier_id, title, qty, unit_price_minor, amount_minor) VALUES ($1,$2,'TRAVEL_DEPARTURE',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [itemId, id, departureId, supplierId, p.title, qty, p.price, subtotal])) {
      await run(`UPDATE travel_departures SET booked = booked + $2 WHERE id = $1`, [departureId, qty]);
    }
    for (let k = 0; k < qty; k++) {
      await ins('vouchers', `INSERT INTO vouchers(id, order_item_id, code, status, issued_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [uid(`voucher:${key}:${k}`), itemId, `TV${codeFor(`voucher:${key}:${k}`, 12)}`, status === 'FULFILLED' ? 'REDEEMED' : 'ISSUED', paidAt]);
    }
    await history('order', id, [
      [null, 'PENDING', createdAt, buyerId, 'USER', 'CREATED'],
      ['PENDING', 'PAYMENT_PENDING', plusMin(createdAt, 1), buyerId, 'USER', 'payment created'],
      ['PAYMENT_PENDING', 'PAID', paidAt, null, 'PROVIDER', 'DEV seed: paid without a payment record (no ledger)'],
      ...(status === 'FULFILLED' ? [['PAID', 'FULFILLED', fulfilledAt, null, 'SYSTEM', 'DEPARTED']] : []),
    ]);
    return { id, code: codeFor(`order:${key}`), total };
  }
  for (const [i, [slug, who, ago, qty, rating, body]] of ORDER_REVIEWS.entries()) {
    const depId = await pastDeparture(slug, ago);
    const key = `past:${slug}:${who}`;
    const o = await order(key, { buyerId: U[who], slug, departureId: depId, qty, status: 'FULFILLED', at: at(-ago - 8 - (i % 5), '13:20'), departAt: at(-ago, PRODUCT[slug].time) });
    await review(`product:${key}`, { authorId: U[who], targetType: 'TRAVEL_PRODUCT', targetId: PRODUCT[slug].id, txType: 'ORDER', txId: o.id, rating, body, createdAt: at(-ago + 1, '21:00') });
  }
  // the guest's upcoming paid order: a 2-seat sunrise tour on their Jeju week (guaranteed: min 2 participants reached)
  const oreum = PRODUCT['jeju-oreum-sunrise'];
  const guestDep = uid('departure:jeju-oreum-sunrise:guest-week');
  const guestDepAt = at(32, '05:30');
  await ins('travel_departures', `INSERT INTO travel_departures(id, product_id, starts_at, ends_at, capacity, min_participants, created_at) VALUES ($1,$2,$3,$4,12,2,now()) ON CONFLICT DO NOTHING`,
    [guestDep, oreum.id, guestDepAt, plusMin(guestDepAt, oreum.minutes)]);
  const guestOrder = await order('upcoming:guest-oreum', { buyerId: guest, slug: 'jeju-oreum-sunrise', departureId: guestDep, qty: 2, status: 'PAID', at: at(-3, '22:41') });
  for (const [key, slug, who, idx, qty] of UPCOMING_ORDERS) {
    const deps = PRODUCT[slug].departures;
    const depId = deps[Math.min(idx, deps.length - 1)];
    if (depId) await order(`upcoming:${key}`, { buyerId: U[who], slug, departureId: depId, qty, status: 'PAID', at: at(-5 - qty, '12:15') });
  }
  // seeded departures whose paid seats reached the minimum are GUARANTEED (travel lifecycle: MIN_PARTICIPANTS_REACHED)
  const seededDepartures = [guestDep, ...Object.values(PRODUCT).flatMap((p) => p.departures)];
  const guaranteed = await run(`UPDATE travel_departures SET status = 'GUARANTEED'
      WHERE id = ANY($1::uuid[]) AND status = 'OPEN' AND starts_at > now() AND booked >= min_participants RETURNING id`, [seededDepartures]);
  for (const r of guaranteed.rows) await history('travel_departure', r.id, [['OPEN', 'GUARANTEED', new Date().toISOString(), null, 'SYSTEM', 'MIN_PARTICIPANTS_REACHED']]);

  // ---- conversations for the guest persona's trips
  const resHallim = RES['upcoming:guest-hallim'];
  if (resHallim) {
    await converse('reservation:guest-hallim', uid('conversation:reservation:guest-hallim'), {
      contextType: 'RESERVATION', contextId: resHallim.id, createdBy: null,
      members: [[guest, 'GUEST', at(-8, '10:04')], [hostB, 'HOST', at(-1, '18:41')]],
      messages: [
        [null, '예약이 확정되었습니다. 체크인 3일 전에 출입 안내가 전달됩니다.', resHallim.confirmedAt],
        [guest, '안녕하세요! 어머니와 함께 일주일 머물 예정이에요. 마당 귤 따기도 할 수 있을까요?', plusMin(resHallim.confirmedAt, 6)],
        [hostB, '반갑습니다 😊 열매가 달려 있으면 바구니를 준비해 둘게요. 협재 해변은 걸어서 5분이에요.', at(-8, '09:12')],
        [guest, '감사합니다! 공항에서 렌터카로 이동할 예정인데 주차는 마당 앞에 하면 될까요?', at(-8, '10:03')],
        [hostB, '네, 돌담 옆 전용 주차 공간을 쓰시면 됩니다. 체크인 3일 전에 출입 비밀번호를 보내드릴게요.', at(-1, '18:40')],
      ],
    });
  }
  const resRecent = RES['guest-gwangalli-recent'];
  if (resRecent) {
    await converse('reservation:guest-gwangalli-recent', uid('conversation:reservation:guest-gwangalli-recent'), {
      contextType: 'RESERVATION', contextId: resRecent.id, createdBy: null,
      members: [[guest, 'GUEST', at(-3, '12:00')], [U['host-namhae'], 'HOST', at(-3, '12:30')]],
      messages: [
        [guest, '내일 체크인 예정입니다. 짐을 먼저 맡길 수 있을까요?', at(-7, '20:10')],
        [U['host-namhae'], '1층 무인 보관함을 이용하시면 됩니다. 비밀번호는 체크인 당일 오전에 보내드릴게요.', at(-7, '20:40')],
        [guest, '덕분에 잘 지내다 갑니다. 주말 드론쇼 최고였어요!', at(-3, '11:30')],
        [U['host-namhae'], '즐거우셨다니 다행이에요. 후기도 남겨 주시면 큰 힘이 됩니다 🙏', at(-3, '12:30')],
      ],
    });
  }
  if (guestOrder?.id) {
    await converse('order:guest-oreum', uid('conversation:order:guest-oreum'), {
      contextType: 'ORDER', contextId: guestOrder.id, createdBy: guest,
      members: [[guest, 'BUYER', at(-2, '09:00')], [supplierUser, 'SUPPLIER', at(-3, '23:10')]],
      messages: [
        [guest, '숙소가 한림 협재리인데 픽업이 가능한가요?', at(-3, '23:02')],
        [supplierUser, '한림·협재 지역은 04:50 픽업이 가능합니다. 출발 전날 확정 문자를 드릴게요!', at(-2, '08:15')],
      ],
    });
  }
  await converse('inquiry:guest-seorak', uid('conversation:inquiry:guest-seorak'), {
    contextType: 'INQUIRY', contextId: PROP['sokcho-seorak-cabin'].id, createdBy: guest,
    members: [[guest, 'GUEST', at(-1, '09:00')], [U['host-gangwon'], 'HOST', at(-1, '08:30')]],
    messages: [
      [guest, '다음 달 주말에 2박 가능한가요? 반려견 동반도 궁금해요.', at(-2, '22:30')],
      [U['host-gangwon'], '안녕하세요! 캐빈은 반려견 동반이 어려운 점 양해 부탁드려요. 반려견과 함께라면 경포 솔숲 단독주택을 추천드립니다.', at(-1, '08:30')],
    ],
  });

  // ---- notifications (in-app only; no notification.created events → no email/SMS fan-out)
  async function note(key, userId, templateKey, title, body, data, createdAt, read, category = 'TRANSACTIONAL') {
    await ins('notifications', `INSERT INTO notifications(id, user_id, template_key, category, title, body, data, dedupe_key, read_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [uid(`notification:${key}`), userId, templateKey, category, title, body, J(data), `seed:${key}`, read ? plusMin(createdAt, 30) : null, createdAt]);
  }
  if (resHallim) {
    const d = { reservationId: resHallim.id, code: resHallim.code, checkIn: resHallim.checkIn, checkOut: resHallim.checkOut, url: `/trips/${resHallim.id}` };
    await note('guest:reservation-confirmed', guest, 'reservation.confirmed.guest', '예약이 확정되었습니다', `예약 ${resHallim.code} (${resHallim.checkIn}~${resHallim.checkOut})`, d, resHallim.confirmedAt, true);
    await note('hostB:reservation-confirmed', hostB, 'reservation.confirmed.host', '새 예약이 확정되었습니다', `예약 ${resHallim.code} (${resHallim.checkIn}~${resHallim.checkOut})`, d, resHallim.confirmedAt, true);
    await note('guest:message-hostB', guest, 'message.received', '새 메시지', '제주 호스트님이 메시지를 보냈습니다.', { url: '/messages' }, at(-1, '18:40'), false);
  }
  if (minaBooking?.id) {
    await note('guest:guide-confirmed', guest, 'guide.booking.confirmed', '가이드 일정이 확정되었습니다', 'Local Friend Mina님과의 성수 산책 일정이 확정되었어요.', { bookingId: minaBooking.id, url: `/guide-bookings/${minaBooking.id}` }, at(-5, '10:00'), false);
    await note('mina:guide-confirmed', guideFriend, 'guide.booking.confirmed', '가이드 일정이 확정되었습니다', '여행자 김님과의 일정이 확정되었습니다.', { bookingId: minaBooking.id, url: `/guide-bookings/${minaBooking.id}` }, at(-5, '10:00'), true);
  }
  if (guestOrder?.id) {
    await note('guest:order-paid', guest, 'order.paid', '주문이 결제되었습니다', `${oreum.title} 2매 · 바우처가 발급되었습니다.`, { orderId: guestOrder.id, code: guestOrder.code, url: `/orders/${guestOrder.id}` }, at(-3, '22:44'), true);
    await note('supplier:order-paid', supplierUser, 'supplier.order.paid', '새 주문이 결제되었습니다', `주문 ${guestOrder.code}`, { orderId: guestOrder.id, url: `/orders/${guestOrder.id}` }, at(-3, '22:44'), false);
  }
  if (resRecent) {
    await note('guest:review-reminder', guest, 'review.reminder', '숙소는 어떠셨나요?', `${PROP['busan-gwangalli-ocean'].title} 이용 후기를 남겨 주세요.`, { reservationId: resRecent.id, url: '/reviews' }, at(-2, '10:00'), false);
  }
  await note('guest:welcome', guest, 'system.welcome', 'JETPOOL에 오신 것을 환영합니다', 'WONT Travel Club의 여행이 JETPOOL로 이어집니다. 첫 한달살기를 찾아보세요.', { url: '/' }, at(-120, '09:00'), true, 'SYSTEM');
  if (EX['countered-busan-mangwon']) {
    const exId = EX['countered-busan-mangwon'].id;
    await note('hostA:exchange-requested', hostA, 'exchange.requested', '새 홈 익스체인지 요청', `${PROP['busan-home'].title} ↔ ${PROP['seoul-mangwon-house'].title}`, { exchangeId: exId, url: `/exchange/${exId}` }, at(-4, '20:12'), true);
    await note('exchanger:exchange-countered', exchanger, 'exchange.countered', '홈 익스체인지 수정 제안', '새 제안(v2)이 도착했습니다.', { exchangeId: exId, offerVersion: 2, url: `/exchange/${exId}` }, at(-1, '09:41'), false);
  }
  if (EX['confirmed-busan-jamsil']) {
    const exId = EX['confirmed-busan-jamsil'].id;
    for (const [k, u] of [['hostA', hostA], ['exchanger', exchanger]]) {
      await note(`${k}:exchange-confirmed`, u, 'exchange.confirmed', '홈 익스체인지 확정', '양쪽 숙소 일정이 확정되었습니다.', { exchangeId: exId, url: `/exchange/${exId}` }, at(-26, '22:10'), true);
    }
  }
  const junho = RES['upcoming:junho-mangwon'];
  if (junho) await note('hostA:reservation-junho', hostA, 'reservation.confirmed.host', '새 예약이 확정되었습니다', `예약 ${junho.code} (${junho.checkIn}~${junho.checkOut})`, { reservationId: junho.id, url: '/host' }, junho.confirmedAt, false);
  await note('hostA:review-received', hostA, 'review.received', '새 리뷰가 등록되었습니다', 'You received a 5-star review.', { url: '/reviews' }, at(-17, '20:30'), false);
  await note('namhae:review-received', U['host-namhae'], 'review.received', '새 리뷰가 등록되었습니다', 'You received a 5-star review.', { url: '/reviews' }, at(-21, '20:30'), false);
  await note('mina:review-received', guideFriend, 'review.received', '새 리뷰가 등록되었습니다', 'You received a 5-star review.', { url: '/reviews' }, at(-44, '18:00'), true);

  // ---- favorites, a collection and an itinerary for the guest persona
  const FAVS = [
    ['PROPERTY', 'jeju-villa'], ['PROPERTY', 'jeju-hallim-stone-house'], ['PROPERTY', 'gangneung-anmok-apt'], ['PROPERTY', 'seoul-seochon-hanok'],
    ['PROPERTY', 'gyeongju-hwangnam-hanok'], ['PROPERTY', 'yeosu-dolsan-ocean'],
  ];
  for (const [i, [t, slug]] of FAVS.entries()) {
    await ins('favorites', `INSERT INTO favorites(user_id, target_type, target_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [guest, t, PROP[slug].id, at(-40 + i * 5, '22:00')]);
  }
  for (const [i, key] of ['guide-jeju', 'guide-jejupro'].entries()) {
    await ins('favorites', `INSERT INTO favorites(user_id, target_type, target_id, created_at) VALUES ($1,'GUIDE',$2,$3) ON CONFLICT DO NOTHING`, [guest, U[key], at(-12 + i, '21:00')]);
  }
  for (const [i, slug] of ['jeju-east-3day-package', 'seoul-palace-moonlight'].entries()) {
    await ins('favorites', `INSERT INTO favorites(user_id, target_type, target_id, created_at) VALUES ($1,'TRAVEL_PRODUCT',$2,$3) ON CONFLICT DO NOTHING`, [guest, PRODUCT[slug].id, at(-10 + i, '21:30')]);
  }
  for (const slug of ['seoul-mangwon-house', 'seoul-jamsil-apt', 'gyeongju-bomun-villa']) {
    await ins('favorites', `INSERT INTO favorites(user_id, target_type, target_id, created_at) VALUES ($1,'PROPERTY',$2,$3) ON CONFLICT DO NOTHING`, [exchanger, PROP[slug].id, at(-35, '21:00')]);
  }
  const collectionId = uid('collection:guest:jeju');
  await ins('collections', `INSERT INTO collections(id, owner_id, name, visibility, created_at) VALUES ($1,$2,'제주 한달살기 후보','PRIVATE',$3) ON CONFLICT DO NOTHING`, [collectionId, guest, at(-38, '22:10')]);
  for (const [slug, noteText] of [['jeju-villa', '노을 테라스!'], ['jeju-hallim-stone-house', '귤나무 마당, 협재 해변 5분'], ['jeju-seogwipo-apt', '한 달 할인 30%']]) {
    await ins('collection_items', `INSERT INTO collection_items(collection_id, target_type, target_id, note, added_at) VALUES ($1,'PROPERTY',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [collectionId, PROP[slug].id, noteText, at(-38, '22:12')]);
  }
  const itineraryId = uid('itinerary:guest:jeju-week');
  if (await ins('itineraries', `INSERT INTO itineraries(id, owner_id, title, start_date, end_date, visibility, created_at, updated_at) VALUES ($1,$2,'제주 서쪽 한 주 살기',$3,$4,'PRIVATE',$5,$5) ON CONFLICT DO NOTHING`,
    [itineraryId, guest, day(30), day(37), at(-8, '23:00')])) {
    const items = [
      [0, 0, 'STAY', PROP['jeju-hallim-stone-house'].id, '한림 돌담 독채 체크인', '15:00', null, '렌터카 픽업 후 이동'],
      [2, 0, 'TRAVEL_PRODUCT', oreum.id, '제주 오름 일출 투어 (2명)', '05:30', '09:30', '04:50 숙소 픽업'],
      [3, 0, 'GUIDE', U['guide-jeju'], '소라와 올레 14코스 걷기', '09:00', '13:00', '고기국수 맛집 들르기'],
      [5, 0, 'NOTE', null, '금능 해변 노을 + 협재 카페', '17:30', null, null],
      [7, 0, 'STAY', PROP['jeju-hallim-stone-house'].id, '체크아웃', '11:00', null, '마당 귤 챙기기 🍊'],
    ];
    for (const [i, [dayIndex, sort, type, ref, title, start, end, noteText]] of items.entries()) {
      await ins('itinerary_items', `INSERT INTO itinerary_items(id, itinerary_id, day_index, sort_order, item_type, ref_id, title, start_time, end_time, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [uid(`itinerary-item:guest:jeju-week:${i}`), itineraryId, dayIndex, sort, type, ref, title, start, end, noteText]);
    }
  }
  // charter interest leads (JET-01 pipeline: content + lead only, no booking)
  await ins('charter_requests', `INSERT INTO charter_requests(id, user_id, contact_name, contact_email, origin, destination, preferred_date, party_size, message, status, created_at)
    VALUES ($1,$2,'여행자 김','guest@jetpool.dev','인천 (ICN)','오키나와 (OKA)',$3,6,'친구들과 4박 5일 오키나와 한달살기 답사를 계획 중이에요.','NEW',$4) ON CONFLICT DO NOTHING`, [uid('charter:guest-okinawa'), guest, day(120), at(-11, '21:00')]);
  await ins('charter_requests', `INSERT INTO charter_requests(id, user_id, contact_name, contact_email, origin, destination, preferred_date, party_size, message, status, admin_note, created_at)
    VALUES ($1,NULL,'워크숍 담당자','team.trip@jetpool.dev','김포 (GMP)','제주 (CJU)',$2,40,'기업 워크숍 2박 3일 단체 이동을 문의드립니다.','CONTACTED','DEV seed: 운항사 2곳 견적 요청 중',$3) ON CONFLICT DO NOTHING`, [uid('charter:workshop-jeju'), day(75), at(-20, '14:00')]);

  // ================================================================================================ projections
  // reputation_scores from PUBLISHED reviews (same formula as reviews/service.ts recomputeReputation)
  const rep = await run(
    `INSERT INTO reputation_scores(target_type, target_id, review_count, rating_avg, updated_at)
     SELECT target_type, target_id, count(*)::int, round(avg(rating)::numeric, 2), now() FROM reviews WHERE status = 'PUBLISHED' GROUP BY target_type, target_id
     ON CONFLICT (target_type, target_id) DO UPDATE SET review_count = EXCLUDED.review_count, rating_avg = EXCLUDED.rating_avg, updated_at = now()
      WHERE reputation_scores.review_count IS DISTINCT FROM EXCLUDED.review_count OR reputation_scores.rating_avg IS DISTINCT FROM EXCLUDED.rating_avg`,
  );
  bump('reputation_scores (upserted)', rep.rowCount);
  await run(`UPDATE guide_profiles g SET rating_avg = s.avg FROM (
      SELECT target_id, round(avg(rating)::numeric, 2) AS avg FROM reviews WHERE target_type = 'GUIDE' AND status = 'PUBLISHED' GROUP BY target_id) s
     WHERE g.user_id = s.target_id AND g.rating_avg IS DISTINCT FROM s.avg`);
  // Search projection (PLAT-01): one deterministic `property.seed_refreshed` outbox event per listing whose projected
  // inputs changed (copy, photos, reputation). The worker's search.projection consumer re-projects it; an unchanged
  // listing gets the same event id again, so a re-run emits nothing.
  const fp = await run(
    `SELECT p.id, p.slug, p.updated_at, rs.review_count, rs.rating_avg,
            (SELECT string_agg(m.public_url, ',' ORDER BY pm.sort_order) FROM property_media pm JOIN media_assets m ON m.id = pm.media_id WHERE pm.property_id = p.id) AS photos
       FROM properties p LEFT JOIN reputation_scores rs ON rs.target_type = 'PROPERTY' AND rs.target_id = p.id
      WHERE p.id = ANY($1::uuid[]) AND p.status = 'PUBLISHED'`,
    [Object.values(PROP).map((p) => p.id)],
  );
  for (const r of fp.rows) {
    // Photos of a media-assigned stay belong to seed-media, which runs after this transaction and emits its own
    // projection event for them. Including them here would fingerprint NULL on a first run and the real list on the
    // next one, so a re-run would emit a second event for an unchanged listing.
    const photos = MEDIA_ASSIGNED_STAYS.has(r.slug) ? null : r.photos;
    const fingerprint = sha256(J([new Date(r.updated_at).toISOString(), r.review_count, r.rating_avg, photos]));
    await ins('outbox_events (search projection)', `INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload, correlation_id) VALUES ($1,'property',$2,'property.seed_refreshed',$3,'seed-dev') ON CONFLICT DO NOTHING`,
      [uid(`outbox:search:${r.id}:${fingerprint}`), r.id, J({ propertyId: r.id, source: 'seed-dev' })]);
  }

  await db.query('COMMIT');
  const total = await one(`SELECT (SELECT count(*) FROM properties WHERE status = 'PUBLISHED')::int AS stays, (SELECT count(*) FROM guide_profiles WHERE status = 'PUBLISHED')::int AS guides,
    (SELECT count(*) FROM travel_products WHERE status = 'PUBLISHED')::int AS products, (SELECT count(*) FROM reviews WHERE status = 'PUBLISHED')::int AS reviews`);
  console.log(`seeded demo data (today=${TODAY}): ${total.stays} stays, ${total.guides} guides, ${total.products} travel products, ${total.reviews} reviews published.`);
  const added = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}+${n}`).join(', ');
  console.log(added ? `new rows: ${added}` : 'nothing new (already seeded)');
  if (skipped.length) console.log(`skipped (dates already taken in this database): ${skipped.join('; ')}`);
  console.log(`login with e.g. guest@jetpool.dev / ${PASSWORD} (admin@jetpool.dev must enroll MFA for admin actions)`);
} catch (e) {
  await db.query('ROLLBACK');
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.end();
}

// Real photos + migrated wontc.co.kr media/content (seed-media.mjs applies data/media/assignments.json; separate
// transaction, idempotent). Without the assignments file the postcard-art listings above are the final state.
if (!process.exitCode && existsSync(MEDIA_ASSIGNMENTS_FILE)) {
  try {
    const { seedMedia } = await import('./seed-media.mjs');
    await seedMedia({ connectionString: url, assignmentsPath: MEDIA_ASSIGNMENTS_FILE });
  } catch (e) {
    console.error(`[seed-media] failed, nothing written: ${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
}
