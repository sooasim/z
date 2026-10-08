'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { GUIDE_TYPE_LABEL, guideView, productView, propertyView } from '@/lib/domain';
import { postcardFor, postcardSet, flagFor, langName } from '@/lib/art';
import { f, str } from '@/lib/shape';
import { placeLabel, countryLabel } from '@/lib/places';
import { localizeExplanation } from '@/lib/enums';
import { HeartButton } from './favorites';
import { ListingCard, type CardBadge } from './ui/listing-card';
import { Avatar, RatingStars } from './ui/display';
import { Money } from './ui/base';
import { Icon } from './ui/icons';

/** Seed data uses generic '/placeholder/N.svg' covers — treat them as missing so city postcards are used instead. */
export function realImages(urls: Array<string | undefined | null>): string[] {
  return urls.filter((u): u is string => !!u && !/^\/?placeholder\//.test(u.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '')));
}

const COMPLIANT = ['ALLOW', 'PASS', 'PASSED', 'COMPLIANT', 'APPROVED', 'VERIFIED', 'ELIGIBLE', 'OK'];

export function isCompliant(status: string) {
  return COMPLIANT.includes((status || '').toUpperCase());
}

export function ComplianceBadge({ status }: { status: string }) {
  const { L } = useI18n();
  if (!status) return null;
  const s = status.toUpperCase();
  if (COMPLIANT.includes(s))
    return (
      <span className="badge ok" title={L('필수 인허가 확인 완료', 'Required permits verified')}>
        <Icon name="check" size={14} /> {L('인허가 확인', 'Compliance OK')}
      </span>
    );
  if (['PENDING', 'IN_REVIEW', 'REVIEW', 'SUBMITTED'].includes(s)) return <span className="badge warn">{L('인허가 검토중', 'Permit in review')}</span>;
  return <span className="badge danger">{L('예약 불가(준수 미충족)', 'Not bookable (compliance)')}</span>;
}

/** Kept for existing call sites — optimistic heart. */
export function FavoriteButton({ targetType, targetId }: { targetType: 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT'; targetId: string }) {
  if (!targetId) return null;
  return (
    <span style={{ display: 'inline-grid', background: 'var(--surface-3)', borderRadius: 999 }}>
      <HeartButton targetType={targetType} targetId={targetId} />
    </span>
  );
}

export function PropertyCard({ p, href, query, active, onHover, priceNote }: { p: any; href?: string; query?: string; active?: boolean; onHover?: (on: boolean) => void; priceNote?: React.ReactNode }) {
  const v = propertyView(p);
  const { L, lang } = useI18n();
  const real = realImages(v.media.length ? v.media.slice(0, 6) : [v.cover]);
  const images = real.length ? real : postcardSet(v.city || v.title, v.id || v.slug);
  const where = [placeLabel(v.city, lang), v.country && v.country !== 'KR' ? countryLabel(v.country, lang) : ''].filter(Boolean).join(', ');
  const hostVerified = Boolean(f(p, 'hostVerified', 'host.verified', 'host.identityVerified')) || str(p, 'host.verificationStatus') === 'VERIFIED';
  const badges: CardBadge[] = [];
  if (isCompliant(v.compliance)) badges.push({ label: L('인허가 확인', 'Compliance OK'), tone: 'ok' });
  if (v.exchangeEnabled) badges.push({ label: L('맞교환', 'Exchange'), tone: 'exchange' });
  if (hostVerified) badges.push({ label: L('인증 호스트', 'Verified host'), tone: 'ok' });
  const nights = Number(f(p, 'nights')) || 0;
  const total = Number(f(p, 'totalMinor', 'quote.totalMinor')) || undefined;
  return (
    <ListingCard
      href={href ?? `/stay/${encodeURIComponent(v.slug)}${query ? '?' + query : ''}`}
      images={images}
      title={v.title}
      meta={[where || L('위치 비공개', 'Location on request'), v.maxGuests ? `${L('최대', 'Up to')} ${v.maxGuests}${L('명', ' guests')}` : '', v.bedrooms !== undefined ? `${L('침실', 'Bedrooms')} ${v.bedrooms}` : ''].filter(Boolean).join(' · ')}
      rating={v.rating}
      reviewCount={v.reviewCount}
      priceMinor={total ?? v.priceMinor}
      currency={v.currency}
      priceSuffix={total && nights ? `${L('총액', 'total')} · ${nights}${L('박', ' nights')}` : L('/ 박', '/ night')}
      priceNote={priceNote ?? (v.exchangeEnabled ? <span className="badge exchange"><Icon name="swap" size={14} /> {L('맞교환 가능', 'Open to exchange')}</span> : undefined)}
      badges={badges}
      fav={v.id ? <HeartButton targetType="PROPERTY" targetId={v.id} /> : undefined}
      active={active}
      onHover={onHover}
    />
  );
}

export function GuideCard({ g }: { g: any }) {
  // /v1/search/guides wraps each hit: { guide, score, explanation[], availability }
  const v = guideView(f(g, 'guide') ?? g);
  const { lang, L } = useI18n();
  // API explanations are English sentences: translate known templates, drop the rest in the Korean UI.
  const why = ((Array.isArray(g?.explanation) ? g.explanation : []) as string[]).map((x) => localizeExplanation(x, lang)).filter((x): x is string => !!x);
  const tl = GUIDE_TYPE_LABEL[v.type] ?? { ko: v.type, en: v.type, paid: false };
  return (
    <article className="gcard">
      <div className="cover" style={{ backgroundImage: `url(${postcardFor(v.city, v.id)})` }} aria-hidden="true" />
      <div className="fav" style={{ position: 'absolute', top: 6, right: 6, zIndex: 2 }}>
        {v.id && <HeartButton targetType="GUIDE" targetId={v.id} />}
      </div>
      <div className="who">
        <Avatar name={v.name} src={v.avatar || undefined} size={64} verified={v.verified} />
        <div className="grow">
          <h3>
            <Link href={`/guides/${v.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              {v.name}
              <span style={{ position: 'absolute', inset: 0 }} aria-hidden="true" />
            </Link>
          </h3>
          <p className="xs muted" style={{ margin: 0 }}>
            {placeLabel(v.city, lang) || L('지역 미정', 'Area TBD')}
          </p>
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className={`badge ${tl.paid ? 'info' : 'ok'}`}>{lang === 'ko' ? tl.ko : tl.en}</span>
        {v.verified && (
          <span className="badge ok">
            <Icon name="check" size={14} /> {L('본인확인', 'Verified')}
          </span>
        )}
        <RatingStars value={v.rating} compact />
      </div>
      {v.languages.length > 0 && (
        <div className="row" style={{ gap: 6 }} aria-label={L('사용 언어', 'Languages')}>
          {v.languages.slice(0, 4).map((l) => (
            <span key={l} className="lang-chip">
              <span className="flag" aria-hidden="true">{flagFor(l)}</span>
              {langName(l, lang)}
            </span>
          ))}
        </div>
      )}
      {(v.headline || v.bio) && <p className="small muted" style={{ margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.headline ? <strong style={{ color: 'var(--text)' }}>{v.headline}. </strong> : null}{v.bio}</p>}
      {why.length > 0 && (
        <p className="xs row" style={{ margin: 0, color: 'var(--link)', gap: 6, flexWrap: 'nowrap' }}>
          <Icon name="sparkle" size={14} style={{ flex: '0 0 auto' }} />
          <span>{why.slice(0, 2).join(' · ')}</span>
        </p>
      )}
      <div className="row between small">
        {tl.paid && v.rateMinor !== undefined ? (
          <span>
            <strong><Money minor={v.rateMinor} currency={v.currency} /></strong> <span className="muted">/ {L('시간', 'hr')}</span>
          </span>
        ) : (
          <span className="muted">{L('무료 교류', 'Free meetup')}</span>
        )}
        <span aria-hidden="true" className="row" style={{ color: 'var(--link)', fontWeight: 700, gap: 2 }}>
          {L('프로필 보기', 'View')} <Icon name="right" size={14} />
        </span>
      </div>
    </article>
  );
}

export function ProductCard({ p }: { p: any }) {
  const v = productView(p);
  const { L, lang } = useI18n();
  const real = realImages([v.cover]);
  const KIND: Record<string, [string, string]> = { TOUR: ['투어', 'Tour'], TICKET: ['티켓', 'Ticket'], PACKAGE: ['패키지', 'Package'], ACTIVITY: ['액티비티', 'Activity'], TRANSFER: ['교통', 'Transfer'] };
  const k = KIND[v.kind.toUpperCase()];
  return (
    <ListingCard
      href={`/travel/${v.id}`}
      images={real.length ? real : postcardSet(v.city || v.title, v.id, 2)}
      title={v.title}
      meta={[placeLabel(v.city, lang), v.durationDays ? `${v.durationDays}${L('일', ' days')}` : '', v.supplier && `${L('공급', 'by')} ${v.supplier}`].filter(Boolean).join(' · ')}
      priceMinor={v.priceMinor}
      currency={v.currency}
      priceSuffix={L('부터', 'from')}
      badges={[{ label: k ? L(k[0], k[1]) : v.kind, tone: 'info' }, ...(v.cancellation && /free|무료/i.test(v.cancellation) ? [{ label: L('무료 취소', 'Free cancel'), tone: 'ok' as const }] : [])]}
      fav={v.id ? <HeartButton targetType="TRAVEL_PRODUCT" targetId={v.id} /> : undefined}
    />
  );
}
