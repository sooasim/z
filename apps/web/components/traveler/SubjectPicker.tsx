'use client';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Photo } from '@/components/media';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { items, str } from '@/lib/shape';
import { formatRange, formatTimeRange } from '@/lib/format';
import { postcardFor } from '@/lib/art';
import { realImages } from '@/components/cards';
import { Badge, Icon, StatusPill } from '@/components/ui';
import { useCachedApi, useCachedMany, useGuides, useProperties } from './hooks';
import { subjectLabel } from './labels';
import s from './traveler.module.css';

export type SubjectType = 'RESERVATION' | 'EXCHANGE' | 'GUIDE_BOOKING' | 'ORDER';
export interface Subject {
  type: SubjectType | '';
  id: string;
}
interface Option {
  type: SubjectType;
  id: string;
  title: string;
  meta: string;
  code: string;
  status: string;
  image: string;
  sort: string;
}

/** The signed-in traveler's recent bookings across domains, newest first, with human titles. */
export function useMySubjects(types: SubjectType[]): { options: Option[]; loading: boolean } {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const want = (t: SubjectType) => !!user && types.includes(t);
  const res = useCachedApi<any>(want('RESERVATION') ? '/v1/reservations?limit=50' : null);
  const exc = useCachedApi<any>(want('EXCHANGE') ? '/v1/exchanges?limit=50' : null);
  const gb = useCachedApi<any>(want('GUIDE_BOOKING') ? '/v1/guide-bookings?role=traveler&limit=50' : null);
  const ord = useCachedApi<any>(want('ORDER') ? '/v1/orders?limit=50' : null);
  const reservations = items(res.data);
  const props = useProperties(reservations.map((r) => str(r, 'propertyId')));
  const bookings = items(gb.data);
  const guides = useGuides(bookings.map((b) => str(b, 'guide_id', 'guideId')));
  const orders = items(ord.data);
  const orderDetails = useCachedMany(orders.map((o) => `/v1/orders/${str(o, 'id')}`));
  const options = useMemo(() => {
    const out: Option[] = [];
    for (const r of reservations) {
      const p = props[str(r, 'propertyId')];
      const city = str(p, 'location.city');
      out.push({
        type: 'RESERVATION',
        id: str(r, 'id'),
        title: str(p, 'title') || L('숙소 예약', 'Stay'),
        meta: str(r, 'checkIn') ? formatRange(str(r, 'checkIn'), str(r, 'checkOut'), lang, { nights: true }) : '',
        code: str(r, 'code'),
        status: str(r, 'status'),
        image: realImages((Array.isArray(p?.media) ? p.media : []).map((m: any) => str(m, 'url')))[0] || postcardFor(city, str(r, 'propertyId')),
        sort: str(r, 'createdAt'),
      });
    }
    for (const x of items(exc.data)) {
      const theirs = str(x, 'role') === 'RESPONDER' ? x.propertyA : x.propertyB;
      const dates = str(x, 'role') === 'RESPONDER' ? x.datesA : x.datesB;
      out.push({
        type: 'EXCHANGE',
        id: str(x, 'id'),
        title: [str(x, 'propertyA.title'), str(x, 'propertyB.title')].filter(Boolean).join(' ⇄ ') || L('홈 맞교환', 'Home exchange'),
        meta: str(dates, 'start') ? formatRange(str(dates, 'start'), str(dates, 'end'), lang) : '',
        code: '',
        status: str(x, 'status'),
        image: postcardFor(str(theirs, 'city'), str(x, 'id')),
        sort: str(x, 'createdAt'),
      });
    }
    for (const b of bookings) {
      const g = guides[str(b, 'guide_id', 'guideId')];
      out.push({
        type: 'GUIDE_BOOKING',
        id: str(b, 'id'),
        title: str(g, 'displayName') ? L(`${str(g, 'displayName')}님과의 가이드 일정`, `Session with ${str(g, 'displayName')}`) : L('가이드 일정', 'Guide session'),
        meta: formatTimeRange(str(b, 'start_at', 'startAt'), str(b, 'end_at', 'endAt'), lang),
        code: '',
        status: str(b, 'status'),
        image: postcardFor(str(g, 'city') || 'Seoul', str(b, 'id')),
        sort: str(b, 'created_at', 'createdAt'),
      });
    }
    for (const o0 of orders) {
      const o = orderDetails[`/v1/orders/${str(o0, 'id')}`] ?? o0;
      const first = Array.isArray(o.items) ? o.items[0] : null;
      out.push({
        type: 'ORDER',
        id: str(o0, 'id'),
        title: str(first, 'title') || L('여행 상품 주문', 'Travel order'),
        meta: '',
        code: str(o, 'code'),
        status: str(o, 'status'),
        image: postcardFor(str(first, 'title'), str(o0, 'id')),
        sort: str(o, 'createdAt'),
      });
    }
    return out.sort((a, b) => b.sort.localeCompare(a.sort));
  }, [reservations, props, exc.data, bookings, guides, orders, orderDetails, L, lang]);
  return { options, loading: res.loading || exc.loading || gb.loading || ord.loading };
}

/**
 * Radio-card picker of the traveler's own bookings (title · dates · code) instead of asking for a raw UUID.
 * Keyboard: ↑/↓ move between options (roving tabindex), Space/Enter select.
 */
export function SubjectPicker({ label, value, onChange, types = ['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER'], optional, hint }: { label: string; value: Subject; onChange: (v: Subject) => void; types?: SubjectType[]; optional?: boolean; hint?: string }) {
  const { L, lang } = useI18n();
  const id = useId();
  const { options, loading } = useMySubjects(types);
  const [filter, setFilter] = useState<SubjectType | 'ALL'>('ALL');
  const shown = options.filter((o) => filter === 'ALL' || o.type === filter);
  const selected = options.find((o) => o.type === value.type && o.id === value.id);
  const presentTypes = types.filter((t) => options.some((o) => o.type === t));
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : -2;
    if (n === -2) return;
    e.preventDefault();
    const els = (e.currentTarget.closest('[role="radiogroup"]') as HTMLElement | null)?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    els?.[Math.max(0, Math.min((els?.length ?? 1) - 1, n))]?.focus();
  };
  return (
    <div className="field">
      <span id={`${id}-l`}>
        {label} {!optional && <span aria-hidden="true">*</span>}
      </span>
      {hint && (
        <small className="hint" id={`${id}-h`}>
          {hint}
        </small>
      )}
      {presentTypes.length > 1 && (
        <div className="chip-group" role="group" aria-label={L('예약 종류', 'Booking type')}>
          {(['ALL', ...presentTypes] as const).map((t) => (
            <button key={t} type="button" className="chip" style={{ minHeight: 32, padding: '4px 12px' }} aria-pressed={filter === t} onClick={() => setFilter(t)}>
              {t === 'ALL' ? L('전체', 'All') : subjectLabel(t, lang)}
            </button>
          ))}
        </div>
      )}
      {loading && !options.length ? (
        <div className="skeleton" style={{ height: 64, borderRadius: 12 }} aria-label={L('불러오는 중', 'Loading')} />
      ) : options.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>{L('선택할 수 있는 예약이 없어요. 관련 예약이 없다면 비워 두셔도 돼요.', 'No bookings to choose from. Leave this empty if it isn’t about a booking.')}</p>
      ) : (
        <ul className={s.pickList} role="radiogroup" aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined}>
          {optional && (
            <li>
              <button type="button" role="radio" aria-checked={!value.id} tabIndex={!value.id ? 0 : -1} className={s.pick} onClick={() => onChange({ type: '', id: '' })} onKeyDown={(e) => onKey(e, 0)}>
                <span className={s.thumb} style={{ display: 'grid', placeItems: 'center' }}>
                  <Icon name="minus" size={18} />
                </span>
                <span>
                  <strong>{L('특정 예약과 관련 없음', 'Not about a specific booking')}</strong>
                  <span className={s.meta}>{L('계정·일반 문의', 'Account or general question')}</span>
                </span>
                <span />
              </button>
            </li>
          )}
          {shown.map((o, i) => {
            const on = o.type === value.type && o.id === value.id;
            const idx = i + (optional ? 1 : 0);
            return (
              <li key={`${o.type}:${o.id}`}>
                <button type="button" role="radio" aria-checked={on} tabIndex={on || (!selected && idx === 0) ? 0 : -1} className={s.pick} onClick={() => onChange({ type: o.type, id: o.id })} onKeyDown={(e) => onKey(e, idx)}>
                  <Photo src={o.image} alt="" sizes="80px" />
                  <span style={{ minWidth: 0 }}>
                    <strong>{o.title}</strong>
                    <span className={s.meta}>{[subjectLabel(o.type, lang), o.meta, o.code].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <StatusPill status={o.status} />
                    {on && <Badge tone="info">{L('선택됨', 'Selected')}</Badge>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {value.id && !selected && !loading && (
        <small className="hint">
          {subjectLabel(value.type, lang)} · {L('목록에 없는 항목이 선택되어 있어요', 'A booking outside this list is selected')}
        </small>
      )}
    </div>
  );
}
