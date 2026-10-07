#!/usr/bin/env node
// Deterministic DEV/STAGING demo data. Refuses to run in production.
// Approved compliance/finance rules created here are placeholders for local testing only — real rules
// require legal/tax approval (Release Gate G9) and must be entered through the admin approval workflow.
import pg from 'pg';
import { randomBytes, scryptSync, createHash } from 'node:crypto';

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

async function user(key, email, name, roles = [], verified = true) {
  const id = uid(`user:${key}`);
  await db.query(
    `INSERT INTO users(id, email, password_hash, display_name, email_verified_at, identity_verified_at)
     VALUES ($1,$2,$3,$4, now(), CASE WHEN $5 THEN now() END)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [id, email, pwHash, name, verified],
  );
  await db.query(`INSERT INTO user_profiles(user_id, preferred_name, languages) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, name, ['ko', 'en']]);
  await db.query(`INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  for (const r of roles) await db.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, r]);
  return id;
}

await db.query('BEGIN');
try {
  const admin = await user('admin', 'admin@jetpool.dev', 'JETPOOL Admin', ['ADMIN', 'COMPLIANCE', 'ACCOUNTING', 'SUPPORT', 'EDITOR']);
  const accountant = await user('accountant', 'accounting@jetpool.dev', '정산 담당', ['ACCOUNTING']);
  const hostA = await user('host-a', 'host.seoul@jetpool.dev', '서울 호스트', ['HOST']);
  const hostB = await user('host-b', 'host.jeju@jetpool.dev', '제주 호스트', ['HOST']);
  const guest = await user('guest', 'guest@jetpool.dev', '여행자 김', []);
  const exchanger = await user('exchanger', 'exchange.busan@jetpool.dev', '부산 교환회원', ['HOST']);
  const guideFriend = await user('guide-friend', 'friend.guide@jetpool.dev', 'Local Friend Mina', ['GUIDE']);
  const guidePro = await user('guide-pro', 'pro.guide@jetpool.dev', 'Pro Guide Jun', ['GUIDE']);
  const supplierUser = await user('supplier', 'supplier@jetpool.dev', 'WONT Tours', ['SUPPLIER']);

  for (const [h, name] of [[hostA, '서울 호스트'], [hostB, '제주 호스트'], [exchanger, '부산 교환회원']]) {
    await db.query(
      `INSERT INTO host_profiles(user_id, display_name, verification_status, status) VALUES ($1,$2,'VERIFIED','APPROVED') ON CONFLICT DO NOTHING`,
      [h, name],
    );
  }
  const policy = (await db.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`)).rows[0].id;
  const props = [
    ['seoul-hanok', hostA, '북촌 한옥 스테이', 'HANOK', 37.5826, 126.9831, 'Seoul', 'KR-11', 180000, true, true],
    ['seoul-apt', hostA, '성수 감성 아파트', 'APARTMENT', 37.5445, 127.0557, 'Seoul', 'KR-11', 120000, true, false],
    ['jeju-villa', hostB, '애월 오션뷰 빌라', 'VILLA', 33.4628, 126.3095, 'Jeju', 'KR-49', 260000, true, true],
    ['busan-home', exchanger, '해운대 한달살기 집', 'APARTMENT', 35.1587, 129.1604, 'Busan', 'KR-26', 90000, false, true],
  ];
  for (const [slug, host, title, type, lat, lng, city, region, price, rental, exchange] of props) {
    const id = uid(`property:${slug}`);
    await db.query(
      `INSERT INTO properties(id, host_id, slug, title, summary, description, property_type, max_guests, bedrooms, beds, bathrooms,
                              lat, lng, city, region, rental_enabled, exchange_enabled, base_price_minor, cleaning_fee_minor,
                              cancellation_policy_id, status, paid_booking_enabled, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,4,2,2,1,$8,$9,$10,$11,$12,$13,$14,30000,$15,'PUBLISHED',$12, now())
       ON CONFLICT (id) DO NOTHING`,
      [id, host, slug, title, `${city}의 ${title}`, `${title} — JETPOOL 데모 숙소입니다. 현지 생활을 경험할 수 있는 공간으로, 장기 체류와 Home Exchange 모두에 적합합니다.`,
       type, lat, lng, city, region, rental, exchange, price, policy],
    );
    await db.query(`INSERT INTO property_addresses(property_id, line1, city, region, public_area_label) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, `${city} 데모로 1`, city, region, `${city} 중심가`]);
    await db.query(`INSERT INTO house_rules(property_id, quiet_hours) VALUES ($1,'22:00-08:00') ON CONFLICT DO NOTHING`, [id]);
    for (const a of ['wifi', 'kitchen', 'washer', 'aircon', 'heating', 'smoke_alarm']) {
      await db.query(`INSERT INTO property_amenities(property_id, amenity_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, a]);
    }
    for (let i = 0; i < 3; i++) {
      const mid = uid(`media:${slug}:${i}`);
      await db.query(
        `INSERT INTO media_assets(id, owner_id, storage_key, public_url, purpose, visibility, mime_type, byte_size, status, moderation_status, ready_at)
         VALUES ($1,$2,$3,$4,'PROPERTY','PUBLIC','image/svg+xml',1024,'READY','APPROVED', now()) ON CONFLICT DO NOTHING`,
        [mid, host, `seed/${slug}/${i}.svg`, `/placeholder/${(i % 3) + 1}.svg`],
      );
      await db.query(`INSERT INTO property_media(property_id, media_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, mid, i]);
    }
  }
  await db.query(`INSERT INTO exchange_profiles(user_id, status, preferred_destinations) VALUES ($1,'ELIGIBLE',$2),($3,'ELIGIBLE',$4) ON CONFLICT DO NOTHING`,
    [exchanger, ['Seoul', 'Jeju'], hostA, ['Busan']]);

  await db.query(
    `INSERT INTO guide_profiles(user_id, guide_type, headline, bio, languages, regions, interests, city, lat, lng, verification_status, status)
     VALUES ($1,'FRIEND','서울 로컬 친구','서울 골목 산책과 카페 투어를 좋아해요.', '{ko,en}', '{Seoul}', '{food,cafe,walking}', 'Seoul', 37.57, 126.98, 'VERIFIED', 'PUBLISHED')
     ON CONFLICT DO NOTHING`, [guideFriend]);
  await db.query(
    `INSERT INTO guide_profiles(user_id, guide_type, headline, bio, languages, regions, interests, city, lat, lng, verification_status, status, paid_enabled, hourly_price_minor)
     VALUES ($1,'PROFESSIONAL','전문 역사 가이드','궁궐과 역사 투어 전문 가이드.', '{ko,en,ja}', '{Seoul,Gyeongju}', '{history,palace}', 'Seoul', 37.58, 126.97, 'VERIFIED', 'PUBLISHED', true, 50000)
     ON CONFLICT DO NOTHING`, [guidePro]);

  const supplierId = uid('supplier:wont');
  await db.query(`INSERT INTO suppliers(id, owner_user_id, name, supplier_type, merchant_of_record, commission_bps, status)
                  VALUES ($1,$2,'WONT Travel Club Tours','TOUR_OPERATOR','JETPOOL',1500,'APPROVED') ON CONFLICT DO NOTHING`, [supplierId, supplierUser]);
  const productId = uid('product:jeju-oreum');
  await db.query(`INSERT INTO travel_products(id, supplier_id, type, slug, title, summary, city, duration_minutes, base_price_minor, status, cancellation_terms)
                  VALUES ($1,$2,'TOUR','jeju-oreum-sunrise','제주 오름 일출 투어','새벽 오름 트레킹과 일출 감상', 'Jeju', 240, 45000, 'PUBLISHED', '{"full_refund_hours":72}')
                  ON CONFLICT DO NOTHING`, [productId, supplierId]);
  for (let d = 7; d <= 35; d += 7) {
    await db.query(`INSERT INTO travel_departures(id, product_id, starts_at, capacity, min_participants) VALUES ($1,$2, now() + make_interval(days => $3), 12, 4) ON CONFLICT DO NOTHING`,
      [uid(`departure:${d}`), productId, d]);
  }

  const cms = [
    ['PAGE', 'jetpool-charter', 'JETPOOL 전세기 공유', '전세기를 함께 나누는 새로운 여행 방식. 현재는 상담 신청만 받고 있습니다.'],
    ['STORY', 'local-life-exchange', '한달살기 맞교환 여행', '한국인과 외국인이 서로의 집을 바꿔 현지인처럼 살아보는 Local Life.'],
    ['DESTINATION', 'jeju', '제주', '오름, 바다, 돌담길 — 제주에서 한 달 살기.'],
    ['FAQ', 'what-is-home-exchange', 'Home Exchange는 무엇인가요?', '서로의 집을 일정 기간 교환해 숙박비 없이 여행하는 방식입니다. 양측 검증과 전자 약정 후 확정됩니다.'],
  ];
  for (const [type, slug, title, body] of cms) {
    await db.query(`INSERT INTO cms_entries(entry_type, slug, title, body_md, status, published_at, author_id) VALUES ($1,$2,$3,$4,'PUBLISHED', now(), $5)
                    ON CONFLICT DO NOTHING`, [type, slug, title, body, admin]);
  }
  await db.query(`INSERT INTO seo_redirects(legacy_path, target_path, approved) VALUES ('/localLife','/exchange',true),('/jetpool','/jetpool-charter',true),('/tour','/travel',true) ON CONFLICT DO NOTHING`);

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
    await db.query(`UPDATE feature_flags SET enabled = true WHERE flag_key IN ('stay.paid_booking','exchange.enabled','guide.paid','travel.commerce','ai.assistant','ai.recommendations')`);
  }
  await db.query('COMMIT');
  console.log(`seeded demo data. login with e.g. guest@jetpool.dev / ${PASSWORD} (admin@jetpool.dev must enroll MFA for admin actions)`);
} catch (e) {
  await db.query('ROLLBACK');
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.end();
}
