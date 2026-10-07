import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import { isEnabled } from '../../platform/flags.js';
import { isRangeFree } from '../../platform/inventory.js';
import type { TravelIntent } from './intent.js';

/**
 * Read-only live search against PostgreSQL (source of truth) for AI-01. Never writes, never holds inventory.
 * Every suggestion cites the availability snapshot timestamp and the reasons it matched.
 */

export interface Suggestion {
  type: 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT';
  id: string;
  mode: 'stay' | 'exchange' | 'guide' | 'travel';
  title: string;
  city: string | null;
  price: { amountMinor: number; currency: string; unit: 'TOTAL_ESTIMATE' | 'NIGHT' | 'HOUR' | 'PERSON' } | null;
  rating: number | null;
  availability: { checked: boolean; available: boolean | null; checkIn: string | null; checkOut: string | null };
  availabilitySnapshotAt: string;
  reasons: string[];
  score: number;
  action: { type: 'OPEN_DETAIL'; href: string; requiresUserConfirmation: true; label: string };
}

const t = (lang: 'ko' | 'en', ko: string, en: string) => (lang === 'ko' ? ko : en);
const fmtMoney = (minor: number, cur: string) => (cur === 'KRW' ? `${Math.round(minor).toLocaleString('ko-KR')}원` : `${(minor / 100).toFixed(2)} ${cur}`);
const cityPatterns = (intent: TravelIntent) => (intent.destination ? intent.destination.aliases.map((a) => `%${a.replace(/[%_\\]/g, '')}%`) : null);
const qs = (o: Record<string, string | number | null | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export async function searchStays(db: Db, intent: TravelIntent, opts: { userId?: string | null; snapshotAt: string; mode: 'stay' | 'exchange'; limit: number }): Promise<Suggestion[]> {
  const lang = intent.language;
  if (opts.mode === 'stay' && !(await isEnabled(db, 'stay.paid_booking', { userId: opts.userId ?? undefined }))) return [];
  if (opts.mode === 'exchange' && !(await isEnabled(db, 'exchange.enabled', { userId: opts.userId ?? undefined }))) return [];
  const rows = await q(
    db,
    `SELECT p.id, p.slug, p.title, p.city, p.region, p.property_type, p.max_guests, p.base_price_minor, p.cleaning_fee_minor, p.currency,
            p.min_nights, p.max_nights, rs.rating_avg, coalesce(rs.review_count, 0) AS review_count
       FROM properties p
       JOIN users h ON h.id = p.host_id AND h.status = 'ACTIVE'
       LEFT JOIN reputation_scores rs ON rs.target_type = 'PROPERTY' AND rs.target_id = p.id
      WHERE p.status = 'PUBLISHED'
        AND (CASE WHEN $1 = 'stay' THEN p.rental_enabled AND p.paid_booking_enabled ELSE p.exchange_enabled END)
        AND ($2::text[] IS NULL OR p.city ILIKE ANY($2) OR p.region ILIKE ANY($2))
        AND ($3::int IS NULL OR p.max_guests >= $3)
        AND ($4::uuid IS NULL OR p.host_id <> $4)
      ORDER BY rs.rating_avg DESC NULLS LAST, rs.review_count DESC NULLS LAST, p.published_at DESC NULLS LAST
      LIMIT 40`,
    [opts.mode, cityPatterns(intent), intent.guests, opts.userId ?? null],
  );
  const out: Suggestion[] = [];
  const hasDates = !!(intent.checkIn && intent.checkOut);
  const nights = intent.nights ?? null;
  for (const p of rows) {
    const reasons: string[] = [];
    if (intent.destination) reasons.push(t(lang, `${intent.destination.city} 지역 숙소`, `Located in ${intent.destination.aliases[1] ?? intent.destination.city}`));
    if (intent.guests) reasons.push(t(lang, `최대 ${p.max_guests}명 수용 (요청 ${intent.guests}명)`, `Sleeps up to ${p.max_guests} (you asked for ${intent.guests})`));
    if (nights && (nights < p.min_nights || nights > p.max_nights)) continue;
    let available: boolean | null = null;
    if (hasDates) {
      const free = await isRangeFree(db, p.id, intent.checkIn!, intent.checkOut!);
      const closed = await q(db, `SELECT 1 FROM availability_days WHERE property_id = $1 AND day >= $2 AND day < $3 AND status = 'UNAVAILABLE' LIMIT 1`, [p.id, intent.checkIn, intent.checkOut]);
      available = free && closed.length === 0;
      if (!available) continue; // never suggest unavailable inventory
      reasons.push(t(lang, `${intent.checkIn} ~ ${intent.checkOut} 예약 가능 (실시간 확인)`, `Available ${intent.checkIn} – ${intent.checkOut} (checked live)`));
    }
    let price: Suggestion['price'] = null;
    if (opts.mode === 'stay' && p.base_price_minor != null) {
      if (nights) {
        const total = p.base_price_minor * nights + (p.cleaning_fee_minor ?? 0);
        price = { amountMinor: total, currency: p.currency, unit: 'TOTAL_ESTIMATE' };
      } else price = { amountMinor: p.base_price_minor, currency: p.currency, unit: 'NIGHT' };
      if (intent.budget && intent.budget.currency === p.currency) {
        const b = intent.budget;
        const compare = b.per === 'NIGHT' ? p.base_price_minor : b.per === 'PERSON' && intent.guests ? Math.ceil(price.amountMinor / intent.guests) : price.amountMinor;
        if (b.per !== 'NIGHT' && price.unit === 'NIGHT' && !nights) {
          // cannot compare a total budget without a stay length: keep, but say so
          reasons.push(t(lang, '박수를 알려주시면 예산 비교가 가능합니다', 'Tell me the number of nights to compare with your budget'));
        } else if (compare > b.amountMinor) continue;
        else reasons.push(t(lang, `예산 ${fmtMoney(b.amountMinor, b.currency)} 이내 (예상 ${fmtMoney(compare, p.currency)})`, `Within your ${fmtMoney(b.amountMinor, b.currency)} budget (est. ${fmtMoney(compare, p.currency)})`));
      }
    }
    if (opts.mode === 'exchange') reasons.push(t(lang, '홈 익스체인지 가능 (상호 확정 필요)', 'Open to home exchange (mutual confirmation required)'));
    if (p.rating_avg) reasons.push(t(lang, `평점 ${Number(p.rating_avg).toFixed(1)} (${p.review_count}개 후기)`, `Rated ${Number(p.rating_avg).toFixed(1)} (${p.review_count} reviews)`));
    if (intent.interests.includes('hanok') && p.property_type === 'HANOK') reasons.push(t(lang, '한옥 숙소', 'Traditional hanok'));
    const score = (p.rating_avg ? Number(p.rating_avg) : 3.5) + (intent.interests.includes('hanok') && p.property_type === 'HANOK' ? 1 : 0);
    const base = opts.mode === 'stay' ? `/stay/${p.slug ?? p.id}` : `/exchange/${p.id}`;
    out.push({
      type: 'PROPERTY',
      id: p.id,
      mode: opts.mode,
      title: p.title,
      city: p.city,
      price,
      rating: p.rating_avg ? Number(p.rating_avg) : null,
      availability: { checked: hasDates, available, checkIn: intent.checkIn, checkOut: intent.checkOut },
      availabilitySnapshotAt: opts.snapshotAt,
      reasons,
      score,
      action: {
        type: 'OPEN_DETAIL',
        href: `${base}?${qs({ checkIn: intent.checkIn, checkOut: intent.checkOut, guests: intent.guests })}`.replace(/\?$/, ''),
        requiresUserConfirmation: true,
        label: t(lang, opts.mode === 'stay' ? '상세 보기 후 직접 예약 확인' : '상세 보기 후 교환 요청', opts.mode === 'stay' ? 'Review details and confirm booking yourself' : 'Review and send an exchange request'),
      },
    });
    if (out.length >= opts.limit) break;
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function searchGuides(db: Db, intent: TravelIntent, opts: { userId?: string | null; snapshotAt: string; limit: number }): Promise<Suggestion[]> {
  const lang = intent.language;
  const paidAllowed = await isEnabled(db, 'guide.paid', { userId: opts.userId ?? undefined });
  const rows = await q(
    db,
    `SELECT g.user_id, g.guide_type, g.headline, g.city, g.regions, g.interests, g.languages, g.paid_enabled, g.hourly_price_minor, g.currency,
            g.rating_avg, u.display_name, g.max_group_size
       FROM guide_profiles g JOIN users u ON u.id = g.user_id AND u.status = 'ACTIVE'
      WHERE g.status = 'PUBLISHED' AND g.verification_status = 'VERIFIED'
        AND ($1::boolean OR NOT g.paid_enabled)
        AND ($2::text[] IS NULL OR g.city ILIKE ANY($2) OR EXISTS (SELECT 1 FROM unnest(g.regions) r WHERE r ILIKE ANY($2)))
        AND ($3::int IS NULL OR g.max_group_size >= $3)
        AND ($4::uuid IS NULL OR g.user_id <> $4)
        AND ($5::date IS NULL OR NOT EXISTS (
              SELECT 1 FROM guide_availability a WHERE a.guide_id = g.user_id AND a.status = 'BLOCKED'
                 AND a.start_at <= $5::date AND a.end_at >= $6::date))
      ORDER BY g.rating_avg DESC NULLS LAST, g.updated_at DESC LIMIT 20`,
    [paidAllowed, cityPatterns(intent), intent.guests, opts.userId ?? null, intent.checkIn, intent.checkOut ?? intent.checkIn],
  );
  return rows.slice(0, opts.limit).map((g) => {
    const overlap = intent.interests.filter((i) => (g.interests ?? []).some((x: string) => x.toLowerCase().includes(i)));
    const reasons: string[] = [];
    if (intent.destination) reasons.push(t(lang, `${intent.destination.city} 현지 가이드`, `Local guide in ${intent.destination.aliases[1] ?? intent.destination.city}`));
    reasons.push(g.paid_enabled ? t(lang, '유료 가이드', 'Paid guide') : t(lang, '무료 가이드 프렌드', 'Free guide friend'));
    if (overlap.length) reasons.push(t(lang, `관심사 일치: ${overlap.join(', ')}`, `Shares your interests: ${overlap.join(', ')}`));
    if (intent.checkIn) reasons.push(t(lang, '요청 기간 전체가 차단되어 있지 않음 (요청 후 가이드 확정 필요)', 'Not blocked for your dates (guide must confirm your request)'));
    return {
      type: 'GUIDE' as const,
      id: g.user_id,
      mode: 'guide' as const,
      title: g.headline ?? g.display_name ?? 'Guide',
      city: g.city,
      price: g.paid_enabled && g.hourly_price_minor != null ? { amountMinor: g.hourly_price_minor, currency: g.currency, unit: 'HOUR' as const } : null,
      rating: g.rating_avg ? Number(g.rating_avg) : null,
      availability: { checked: !!intent.checkIn, available: intent.checkIn ? true : null, checkIn: intent.checkIn, checkOut: intent.checkOut },
      availabilitySnapshotAt: opts.snapshotAt,
      reasons,
      score: (g.rating_avg ? Number(g.rating_avg) : 3.5) + overlap.length * 0.5,
      action: {
        type: 'OPEN_DETAIL' as const,
        href: `/guide-friends/${g.user_id}?${qs({ start: intent.checkIn, end: intent.checkOut, partySize: intent.guests })}`.replace(/\?$/, ''),
        requiresUserConfirmation: true as const,
        label: t(lang, '프로필 보기 후 직접 요청', 'View profile and send a request yourself'),
      },
    };
  }).sort((a, b) => b.score - a.score);
}

export async function searchTravelProducts(db: Db, intent: TravelIntent, opts: { userId?: string | null; snapshotAt: string; limit: number }): Promise<Suggestion[]> {
  const lang = intent.language;
  if (!(await isEnabled(db, 'travel.commerce', { userId: opts.userId ?? undefined }))) return [];
  const rows = await q(
    db,
    `SELECT tp.id, tp.slug, tp.title, tp.city, tp.type, tp.base_price_minor, tp.currency,
            (SELECT min(d.starts_at) FROM travel_departures d WHERE d.product_id = tp.id AND d.status IN ('OPEN','GUARANTEED')
                AND d.booked + coalesce($3::int, 1) <= d.capacity AND d.starts_at > now()
                AND ($4::date IS NULL OR (d.starts_at >= $4::date AND d.starts_at < ($5::date + 1)))) AS next_departure
       FROM travel_products tp JOIN suppliers s ON s.id = tp.supplier_id AND s.status = 'APPROVED'
      WHERE tp.status = 'PUBLISHED' AND ($1::text[] IS NULL OR tp.city ILIKE ANY($1))
        AND ($2::bigint IS NULL OR tp.base_price_minor IS NULL OR tp.base_price_minor <= $2)
      ORDER BY tp.updated_at DESC LIMIT 30`,
    [cityPatterns(intent), intent.budget?.currency === 'KRW' && intent.budget.per !== 'NIGHT' ? intent.budget.amountMinor : null, intent.guests, intent.checkIn, intent.checkOut ?? intent.checkIn],
  );
  const out: Suggestion[] = [];
  for (const p of rows) {
    if (!p.next_departure) continue; // only bookable departures with remaining capacity
    const dep = new Date(p.next_departure).toISOString();
    const reasons = [
      ...(intent.destination ? [t(lang, `${intent.destination.city} 상품`, `In ${intent.destination.aliases[1] ?? intent.destination.city}`)] : []),
      t(lang, `잔여석 있는 출발일 ${dep.slice(0, 10)}`, `Seats available on ${dep.slice(0, 10)}`),
    ];
    out.push({
      type: 'TRAVEL_PRODUCT',
      id: p.id,
      mode: 'travel',
      title: p.title,
      city: p.city,
      price: p.base_price_minor != null ? { amountMinor: p.base_price_minor, currency: p.currency, unit: 'PERSON' } : null,
      rating: null,
      availability: { checked: true, available: true, checkIn: intent.checkIn, checkOut: intent.checkOut },
      availabilitySnapshotAt: opts.snapshotAt,
      reasons,
      score: 3,
      action: { type: 'OPEN_DETAIL', href: `/travel/${p.slug ?? p.id}`, requiresUserConfirmation: true, label: t(lang, '상품 보기 후 직접 구매 확인', 'View and confirm purchase yourself') },
    });
    if (out.length >= opts.limit) break;
  }
  return out;
}
