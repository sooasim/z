import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { isEnabled } from '../../platform/flags.js';

/**
 * AI-02: non-authoritative recommendation rails. Candidates are ALWAYS filtered to published, compliant and
 * bookable items first (ranking never bypasses legal/compliance/availability filters); behavioural
 * personalisation applies only with flag `ai.recommendations` AND no personalization opt-out.
 */

export interface RecItem {
  type: 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT';
  id: string;
  title: string;
  city: string | null;
  score: number;
  reasons: string[];
  href: string;
}

interface Candidate extends RecItem {
  features: string[];
}

/** Rebuild behavioural features from favorites (1.0), recent views (0.3) and bookings (2.0), normalised to [0,1]. */
export async function refreshRecommendationFeatures(db: Db, userId: string): Promise<Map<string, number>> {
  const rows = await q<{ key: string; w: number }>(
    db,
    `WITH signals AS (
       SELECT p.city, p.property_type, 1.0 AS w FROM favorites f JOIN properties p ON p.id = f.target_id
        WHERE f.user_id = $1 AND f.target_type = 'PROPERTY'
       UNION ALL
       SELECT p.city, p.property_type, 0.3 FROM analytics_events e JOIN properties p ON p.id::text = e.properties->>'propertyId'
        WHERE e.user_id = $1 AND e.event_name = 'property.viewed' AND e.occurred_at > now() - interval '90 days'
       UNION ALL
       SELECT p.city, p.property_type, 2.0 FROM reservations r JOIN properties p ON p.id = r.property_id
        WHERE r.guest_id = $1 AND r.status IN ('CONFIRMED','CHECKED_IN','COMPLETED')
     )
     SELECT 'city:' || city AS key, sum(w)::float AS w FROM signals WHERE city IS NOT NULL GROUP BY city
     UNION ALL
     SELECT 'property_type:' || property_type, sum(w)::float FROM signals GROUP BY property_type
     UNION ALL
     SELECT 'guide_interest:' || i, count(*)::float FROM favorites f JOIN guide_profiles g ON g.user_id = f.target_id, unnest(g.interests) i
      WHERE f.user_id = $1 AND f.target_type = 'GUIDE' GROUP BY i`,
    [userId],
  );
  const max = Math.max(1, ...rows.map((r) => r.w));
  const features = new Map(rows.map((r) => [r.key, r.w / max]));
  await db.query(`DELETE FROM recommendation_features WHERE user_id = $1`, [userId]);
  for (const [k, v] of features) {
    await db.query(`INSERT INTO recommendation_features(user_id, feature_key, value) VALUES ($1,$2,$3)`, [userId, k, v]);
  }
  return features;
}

async function candidates(db: Db, userId: string | null): Promise<Candidate[]> {
  const subject = userId ? { userId } : undefined;
  // sequential: `db` may be a single transaction client, which must not run concurrent queries (pg@9 removes queuing)
  const stayOn = await isEnabled(db, 'stay.paid_booking', subject);
  const exchangeOn = await isEnabled(db, 'exchange.enabled', subject);
  const guidePaidOn = await isEnabled(db, 'guide.paid', subject);
  const travelOn = await isEnabled(db, 'travel.commerce', subject);
  const out: Candidate[] = [];
  const props = await q(
    db,
    `SELECT p.id, p.slug, p.title, p.city, p.property_type, p.published_at, rs.rating_avg, coalesce(rs.review_count,0) AS review_count,
            (SELECT count(*) FROM favorites f WHERE f.target_type = 'PROPERTY' AND f.target_id = p.id AND f.created_at > now() - interval '90 days')::int AS favs,
            (SELECT count(*) FROM reservations r WHERE r.property_id = p.id AND r.status IN ('CONFIRMED','CHECKED_IN','COMPLETED') AND r.created_at > now() - interval '180 days')::int AS bookings
       FROM properties p JOIN users h ON h.id = p.host_id AND h.status = 'ACTIVE'
       LEFT JOIN reputation_scores rs ON rs.target_type = 'PROPERTY' AND rs.target_id = p.id
      WHERE p.status = 'PUBLISHED'
        AND (($1::boolean AND p.rental_enabled AND p.paid_booking_enabled)
             OR ($2::boolean AND p.exchange_enabled AND NOT p.rental_enabled))
        AND ($3::uuid IS NULL OR p.host_id <> $3)
        -- availability: exclude listings fully blocked for the next 30 days
        AND NOT EXISTS (SELECT 1 FROM inventory_blocks b WHERE b.property_id = p.id AND b.state = 'ACTIVE'
                          AND (b.expires_at IS NULL OR b.expires_at > now())
                          AND b.stay_range @> daterange(current_date, current_date + 30, '[)'))
      LIMIT 500`,
    [stayOn, exchangeOn, userId],
  );
  for (const p of props) {
    const reasons: string[] = [];
    let score = Math.log1p(p.favs + 2 * p.bookings);
    if (p.favs + p.bookings > 0) reasons.push('popular');
    if (p.rating_avg && Number(p.rating_avg) >= 4.5 && p.review_count >= 3) {
      score += 1;
      reasons.push('highly_rated');
    } else if (p.rating_avg) score += Number(p.rating_avg) / 10;
    if (p.published_at && Date.now() - new Date(p.published_at).getTime() < 30 * 86400_000) {
      score += 0.5;
      reasons.push('new');
    }
    out.push({ type: 'PROPERTY', id: p.id, title: p.title, city: p.city, score, reasons, href: `/stay/${p.slug ?? p.id}`, features: [`city:${p.city}`, `property_type:${p.property_type}`] });
  }
  const guides = await q(
    db,
    `SELECT g.user_id, g.headline, g.city, g.interests, g.rating_avg, g.created_at, u.display_name,
            (SELECT count(*) FROM favorites f WHERE f.target_type = 'GUIDE' AND f.target_id = g.user_id)::int AS favs
       FROM guide_profiles g JOIN users u ON u.id = g.user_id AND u.status = 'ACTIVE'
      WHERE g.status = 'PUBLISHED' AND g.verification_status = 'VERIFIED' AND ($1::boolean OR NOT g.paid_enabled)
        AND ($2::uuid IS NULL OR g.user_id <> $2)
      LIMIT 300`,
    [guidePaidOn, userId],
  );
  for (const g of guides) {
    const reasons: string[] = [];
    let score = Math.log1p(g.favs);
    if (g.favs > 0) reasons.push('popular');
    if (g.rating_avg && Number(g.rating_avg) >= 4.5) {
      score += 1;
      reasons.push('highly_rated');
    }
    if (Date.now() - new Date(g.created_at).getTime() < 30 * 86400_000) {
      score += 0.5;
      reasons.push('new');
    }
    out.push({ type: 'GUIDE', id: g.user_id, title: g.headline ?? g.display_name ?? 'Guide', city: g.city, score, reasons, href: `/guide-friends/${g.user_id}`, features: [`city:${g.city}`, ...(g.interests ?? []).map((i: string) => `guide_interest:${i}`)] });
  }
  if (travelOn) {
    const products = await q(
      db,
      `SELECT tp.id, tp.slug, tp.title, tp.city, tp.created_at FROM travel_products tp JOIN suppliers s ON s.id = tp.supplier_id AND s.status = 'APPROVED'
        WHERE tp.status = 'PUBLISHED' AND EXISTS (SELECT 1 FROM travel_departures d WHERE d.product_id = tp.id AND d.status IN ('OPEN','GUARANTEED') AND d.booked < d.capacity AND d.starts_at > now())
        LIMIT 300`,
    );
    for (const p of products) {
      const isNew = Date.now() - new Date(p.created_at).getTime() < 30 * 86400_000;
      out.push({ type: 'TRAVEL_PRODUCT', id: p.id, title: p.title, city: p.city, score: isNew ? 0.5 : 0, reasons: isNew ? ['new'] : [], href: `/travel/${p.slug ?? p.id}`, features: [`city:${p.city}`] });
    }
  }
  return out;
}

export async function getRecommendations(db: Db, ctx: Ctx, args: { userId: string | null; surface: string; limit: number }) {
  let personalizationAllowed = false;
  let features = new Map<string, number>();
  if (args.userId) {
    const pref = await maybeOne<{ personalization_opt_out: boolean }>(db, `SELECT personalization_opt_out FROM user_preferences WHERE user_id = $1`, [args.userId]);
    const optedOut = !!pref?.personalization_opt_out;
    if (optedOut) {
      // opt-out removes behavioural personalisation entirely, including stored features
      await db.query(`DELETE FROM recommendation_features WHERE user_id = $1`, [args.userId]);
    } else if (await isEnabled(db, 'ai.recommendations', { userId: args.userId })) {
      personalizationAllowed = true;
      features = await refreshRecommendationFeatures(db, args.userId);
    }
  }
  const surfaceTypes: Record<string, string[]> = { stay: ['PROPERTY'], exchange: ['PROPERTY'], guide: ['GUIDE'], travel: ['TRAVEL_PRODUCT'] };
  const cands = (await candidates(db, args.userId)).filter((c) => !surfaceTypes[args.surface] || surfaceTypes[args.surface].includes(c.type));
  const personalized = personalizationAllowed && features.size > 0;
  for (const c of cands) {
    if (!personalized) continue;
    const boost = c.features.reduce((s, f) => s + (features.get(f) ?? 0), 0);
    if (boost > 0) {
      c.score += 2 * boost;
      c.reasons.push('matches_your_activity');
    }
  }
  // stable ordering: score desc, then id for determinism; light diversity (max 60% of one type)
  cands.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const cap = Math.max(1, Math.ceil(args.limit * 0.6));
  const counts: Record<string, number> = {};
  const picked: Candidate[] = [];
  const overflow: Candidate[] = [];
  for (const c of cands) {
    if (picked.length >= args.limit) break;
    if ((counts[c.type] ?? 0) >= cap) {
      overflow.push(c);
      continue;
    }
    counts[c.type] = (counts[c.type] ?? 0) + 1;
    picked.push(c);
  }
  for (const c of overflow) if (picked.length < args.limit) picked.push(c);
  const items: RecItem[] = picked.map(({ features: _f, ...rest }) => ({ ...rest, score: Math.round(rest.score * 1000) / 1000, reasons: rest.reasons.length ? rest.reasons : ['catalog'] }));
  for (const [i, it] of items.entries()) {
    await db.query(`INSERT INTO recommendation_impressions(user_id, surface, item_type, item_id, position, personalized) VALUES ($1,$2,$3,$4,$5,$6)`, [
      args.userId,
      args.surface,
      it.type,
      it.id,
      i,
      personalized,
    ]);
  }
  if (items.length) {
    await emit(db, ctx, {
      aggregateType: 'recommendation',
      aggregateId: args.userId ?? 'anonymous',
      eventType: 'recommendation.impression',
      payload: { surface: args.surface, count: items.length, personalized, userId: args.userId },
    });
  }
  return { surface: args.surface, personalized, items };
}
