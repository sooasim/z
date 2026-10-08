#!/usr/bin/env node
// Adds a handful of extra published listings to an ISOLATED demo-recording database so the static
// GitHub Pages demo has more than the four seed-dev listings to browse. Same insert pattern as
// packages/db/seed-dev.mjs; photos point at the web app's own /art/postcards illustrations.
//
// Refuses to touch anything but a database whose name ends in "_demo" (see scripts/pages/record.sh).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'packages/db/package.json'));
const pg = require('pg');

const url = process.env.DATABASE_URL;
if (!url || !/_demo(\?|$)/.test(url)) {
  console.error('demo-enrich: DATABASE_URL must point at an isolated *_demo database');
  process.exit(1);
}

// Must match seed-dev.mjs so we can reference its users.
const seedUid = (name) => {
  const h = createHash('sha256').update(`jetpool-seed:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const uid = (name) => {
  const h = createHash('sha256').update(`jetpool-demo:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-b${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const hostA = seedUid('user:host-a'); // host.seoul
const hostB = seedUid('user:host-b'); // host.jeju
const exchanger = seedUid('user:exchanger'); // exchange.busan

// slug, host, title, type, lat, lng, city, region, price, rental, exchange, maxGuests, bedrooms, art[], amenities[], summary
const LISTINGS = [
  ['jeju-stone-house', hostB, '서귀포 돌담 독채', 'HOUSE', 33.2541, 126.5601, 'Jeju', 'KR-49', 210000, true, false, 5, 2, ['jeju', 'coast', 'mountain'], ['wifi', 'kitchen', 'washer', 'parking', 'heating'], '귤밭 사이 돌담길 끝, 한라산이 보이는 조용한 독채'],
  ['jeju-hallim-studio', hostB, '한림 바다 앞 스튜디오', 'STUDIO', 33.4103, 126.2652, 'Jeju', 'KR-49', 98000, true, false, 2, 1, ['coast', 'jeju', 'city'], ['wifi', 'kitchen', 'workspace', 'aircon'], '협재 해변까지 걸어서 5분, 워케이션에 딱 맞는 스튜디오'],
  ['sokcho-seaside-guesthouse', hostB, '속초 바다 앞 게스트하우스', 'GUESTHOUSE', 38.1907, 128.6012, 'Sokcho', 'KR-42', 75000, true, false, 3, 1, ['gangneung', 'coast', 'mountain'], ['wifi', 'heating', 'parking'], '설악산과 동해를 함께 누리는 아담한 게스트하우스'],
  ['seoul-yeonnam-loft', hostA, '연남동 루프탑 로프트', 'STUDIO', 37.5622, 126.9235, 'Seoul', 'KR-11', 135000, true, false, 2, 1, ['seoul', 'city', 'coast'], ['wifi', 'kitchen', 'washer', 'workspace', 'aircon'], '경의선 숲길 바로 옆, 루프탑이 있는 복층 로프트'],
  ['gangneung-anmok-house', hostA, '강릉 안목 커피거리 바다집', 'HOUSE', 37.7726, 128.9474, 'Gangneung', 'KR-42', 160000, true, true, 6, 3, ['gangneung', 'coast', 'mountain'], ['wifi', 'kitchen', 'washer', 'parking', 'aircon', 'heating'], '창밖으로 바다가 보이는 커피거리 3층 단독주택'],
  ['gyeongju-hwangnidan-hanok', hostA, '경주 황리단길 한옥', 'HANOK', 35.8382, 129.2096, 'Gyeongju', 'KR-47', 150000, true, false, 4, 2, ['gyeongju', 'mountain', 'city'], ['wifi', 'kitchen', 'heating', 'aircon'], '대릉원 담장 너머, 마당이 있는 전통 한옥'],
  ['busan-gwangalli-view', exchanger, '광안리 오션뷰 아파트', 'APARTMENT', 35.1532, 129.1186, 'Busan', 'KR-26', 140000, true, true, 4, 2, ['busan', 'coast', 'city'], ['wifi', 'kitchen', 'washer', 'aircon', 'workspace'], '광안대교 야경이 정면으로 보이는 고층 아파트'],
];

const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query('BEGIN');
try {
  const policy = (await db.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`)).rows[0].id;
  for (const [slug, host, title, type, lat, lng, city, region, price, rental, exchange, maxGuests, bedrooms, art, amenities, summary] of LISTINGS) {
    const id = uid(`property:${slug}`);
    await db.query(
      `INSERT INTO properties(id, host_id, slug, title, summary, description, property_type, max_guests, bedrooms, beds, bathrooms,
                              lat, lng, city, region, rental_enabled, exchange_enabled, base_price_minor, cleaning_fee_minor,
                              cancellation_policy_id, status, paid_booking_enabled, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,1,$10,$11,$12,$13,$14,$15,$16,30000,$17,'PUBLISHED',$14, now())
       ON CONFLICT (id) DO NOTHING`,
      [id, host, slug, title, summary, `${title} — ${summary}. JETPOOL 데모 숙소입니다. 한 달 살기와 워케이션, 가족 여행 모두에 잘 맞는 공간이에요.`,
       type, maxGuests, bedrooms, lat, lng, city, region, rental, exchange, price, policy],
    );
    await db.query(`INSERT INTO property_addresses(property_id, line1, city, region, public_area_label) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, `${city} 데모로 ${LISTINGS.findIndex((l) => l[0] === slug) + 2}`, city, region, `${city} 중심가`]);
    await db.query(`INSERT INTO house_rules(property_id, quiet_hours) VALUES ($1,'22:00-08:00') ON CONFLICT DO NOTHING`, [id]);
    for (const a of [...amenities, 'smoke_alarm']) {
      await db.query(`INSERT INTO property_amenities(property_id, amenity_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, a]);
    }
    for (let i = 0; i < art.length; i++) {
      const mid = uid(`media:${slug}:${i}`);
      await db.query(
        `INSERT INTO media_assets(id, owner_id, storage_key, public_url, purpose, visibility, mime_type, byte_size, status, moderation_status, ready_at)
         VALUES ($1,$2,$3,$4,'PROPERTY','PUBLIC','image/svg+xml',1024,'READY','APPROVED', now()) ON CONFLICT DO NOTHING`,
        [mid, host, `demo/${slug}/${i}.svg`, `/art/postcards/${art[i]}.svg`],
      );
      await db.query(`INSERT INTO property_media(property_id, media_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, mid, i]);
    }
  }
  // The professional (paid) guide needs a verified business registration, otherwise the worker's paid-gate
  // re-evaluation hides the profile (invariant 7).
  await db.query(
    `INSERT INTO guide_qualifications(id, guide_id, qualification_type, reference_no, valid_until, status, verified_by, verified_at)
     VALUES ($1,$2,'BUSINESS_REGISTRATION','DEMO-000-00-0000', (now() + interval '2 years')::date, 'VERIFIED', $3, now()) ON CONFLICT DO NOTHING`,
    [uid('qualification:guide-pro'), seedUid('user:guide-pro'), seedUid('user:admin')],
  );
  await db.query('COMMIT');
  console.log(`demo-enrich: ${LISTINGS.length} extra listings ensured`);
} catch (e) {
  await db.query('ROLLBACK');
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.end();
}
