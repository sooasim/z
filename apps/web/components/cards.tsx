'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { GUIDE_TYPE_LABEL, guideView, productView, propertyView } from '@/lib/domain';
import { Money } from './ui';

export function ComplianceBadge({ status }: { status: string }) {
  const { L } = useI18n();
  if (!status) return null;
  const s = status.toUpperCase();
  if (['PASS', 'PASSED', 'COMPLIANT', 'APPROVED', 'VERIFIED', 'ELIGIBLE', 'OK'].includes(s))
    return (
      <span className="badge ok" title={L('필수 인허가 확인 완료', 'Required permits verified')}>
        ✓ {L('인허가 확인', 'Permit verified')}
      </span>
    );
  if (['PENDING', 'IN_REVIEW', 'REVIEW', 'SUBMITTED'].includes(s)) return <span className="badge warn">{L('인허가 검토중', 'Permit in review')}</span>;
  return <span className="badge danger">{L('예약 불가(준수 미충족)', 'Not bookable (compliance)')}</span>;
}

export function FavoriteButton({ targetType, targetId }: { targetType: 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT'; targetId: string }) {
  const { user } = useAuth();
  const { L } = useI18n();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user || !targetId) return null;
  return (
    <button
      type="button"
      className="btn sm"
      aria-pressed={on}
      disabled={busy}
      onClick={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          if (on) await api(`/v1/favorites`, { method: 'DELETE', query: { targetType, targetId } });
          else await api('/v1/favorites', { method: 'POST', body: { targetType, targetId } });
          setOn(!on);
        } catch {
          /* non-critical */
        } finally {
          setBusy(false);
        }
      }}
    >
      {on ? '♥' : '♡'} <span className="sr-only">{L('저장', 'Save')}</span>
    </button>
  );
}

export function PropertyCard({ p, href, query }: { p: any; href?: string; query?: string }) {
  const v = propertyView(p);
  const { L } = useI18n();
  return (
    <article className="card listing-card">
      <Link href={href ?? `/stay/${encodeURIComponent(v.slug)}${query ? '?' + query : ''}`} className="card link flat" style={{ border: 0, padding: 0 }}>
        <div className="media">{v.cover ? <img src={v.cover} alt="" loading="lazy" /> : <span aria-hidden="true">JETPOOL</span>}</div>
        <div className="body">
          <h3>{v.title}</h3>
          <p className="muted small" style={{ margin: 0 }}>
            {[v.city, v.country].filter(Boolean).join(', ') || L('위치 비공개', 'Location hidden')}
            {v.rating ? ` · ★ ${v.rating.toFixed(1)} (${v.reviewCount})` : ''}
          </p>
          <div className="row between" style={{ marginTop: 6 }}>
            <span>
              {v.priceMinor !== undefined ? (
                <>
                  <strong>
                    <Money minor={v.priceMinor} currency={v.currency} />
                  </strong>{' '}
                  <span className="muted small">/ {L('박', 'night')}</span>
                </>
              ) : v.exchangeEnabled ? (
                <span className="badge exchange">{L('맞교환 가능', 'Exchange')}</span>
              ) : null}
            </span>
            <ComplianceBadge status={v.compliance} />
          </div>
        </div>
      </Link>
    </article>
  );
}

export function GuideCard({ g }: { g: any }) {
  const v = guideView(g);
  const { lang, L } = useI18n();
  const tl = GUIDE_TYPE_LABEL[v.type] ?? { ko: v.type, en: v.type, paid: false };
  return (
    <article className="card">
      <Link href={`/guides/${v.id}`} className="card link flat" style={{ border: 0, padding: 0 }}>
        <div className="row">
          <div aria-hidden="true" style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--c-primary-soft)', display: 'grid', placeItems: 'center', fontWeight: 800, color: 'var(--c-primary)' }}>
            {v.name.slice(0, 1)}
          </div>
          <div>
            <h3 style={{ margin: 0 }}>{v.name}</h3>
            <p className="muted small" style={{ margin: 0 }}>
              {v.city} {v.languages.length ? '· ' + v.languages.join(', ') : ''}
            </p>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <span className={`badge ${tl.paid ? 'info' : 'ok'}`}>{lang === 'ko' ? tl.ko : tl.en}</span>
          {v.verified && <span className="badge ok">✓ {L('본인확인', 'Verified')}</span>}
          {v.rateMinor !== undefined && tl.paid && (
            <span className="small">
              <Money minor={v.rateMinor} currency={v.currency} /> / {L('시간', 'hr')}
            </span>
          )}
        </div>
        {v.bio && (
          <p className="small muted" style={{ marginTop: 8 }}>
            {v.bio.slice(0, 120)}
          </p>
        )}
      </Link>
    </article>
  );
}

export function ProductCard({ p }: { p: any }) {
  const v = productView(p);
  const { L } = useI18n();
  return (
    <article className="card listing-card">
      <Link href={`/travel/${v.id}`} className="card link flat" style={{ border: 0, padding: 0 }}>
        <div className="media">{v.cover ? <img src={v.cover} alt="" loading="lazy" /> : <span aria-hidden="true">{v.kind}</span>}</div>
        <div className="body">
          <span className="badge info">{v.kind}</span>
          <h3 style={{ marginTop: 6 }}>{v.title}</h3>
          <p className="muted small" style={{ margin: 0 }}>
            {v.city} {v.supplier && `· ${L('공급사', 'Supplier')}: ${v.supplier}`}
          </p>
          {v.priceMinor !== undefined && (
            <p style={{ margin: '6px 0 0' }}>
              <strong>
                <Money minor={v.priceMinor} currency={v.currency} />
              </strong>{' '}
              <span className="muted small">{L('부터', 'from')}</span>
            </p>
          )}
        </div>
      </Link>
    </article>
  );
}
