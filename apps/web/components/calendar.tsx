'use client';
import { useMemo, useState } from 'react';
import { monthWeeks as weeksOf, isoDate, parseDateRange, formatDateLong, formatPriceShort } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { f, str } from '@/lib/shape';
import { Icon } from './ui/icons';
import { pickPair } from '@/lib/phrases';

export type DayKind = 'paid' | 'exchange' | 'block' | 'hold' | 'unavail' | '';
export interface DayInfo {
  kind: DayKind;
  /** Caller-provided state label ("가능", "선택" …); replaces the kind wording (visible + spoken). */
  label?: string;
  /** Reservation / exchange code shown in the cell (spoken after the kind). */
  code?: string;
  price?: number;
  currency?: string;
}

/** Normalise calendar API rows → map of date → kind. Accepts per-day rows or ranges (start/end or daterange). */
export function calendarDays(rows: any[]): Record<string, DayInfo> {
  const out: Record<string, DayInfo> = {};
  const kindOf = (r: any): DayKind => {
    const t = (str(r, 'blockType', 'type', 'kind', 'source', 'reason', 'status') || '').toUpperCase();
    if (t.includes('EXCHANGE')) return 'exchange';
    if (t.includes('HOLD')) return 'hold';
    if (t.includes('RESERV') || t.includes('BOOK') || t.includes('PAID')) return 'paid';
    if (t.includes('HOST') || t.includes('BLOCK') || t.includes('MANUAL') || t.includes('OWNER')) return 'block';
    if (f(r, 'available') === false || t === 'UNAVAILABLE' || t === 'BLOCKED') return 'unavail';
    return '';
  };
  for (const r of rows ?? []) {
    const date = str(r, 'date', 'day');
    const price = Number(f(r, 'priceMinor', 'nightlyPriceMinor')) || undefined;
    const currency = str(r, 'currency') || undefined;
    if (date) {
      const blk = f<any>(r, 'block');
      if (blk) {
        // Never show the raw sourceType ("RESERVATION"): a reservation code when we have one, else the kind label.
        out[date.slice(0, 10)] = { kind: kindOf({ type: str(blk, 'type', 'blockType', 'sourceType') }) || 'block', code: str(blk, 'reservation.code', 'code') || undefined, price, currency };
        continue;
      }
      const st = (str(r, 'status', 'availability') || '').toUpperCase();
      if (st === 'BOOKED' || st === 'BLOCKED' || st === 'UNAVAILABLE') {
        out[date.slice(0, 10)] = { kind: 'unavail', price, currency };
        continue;
      }
      const k = st === 'AVAILABLE' ? '' : kindOf(r);
      out[date.slice(0, 10)] = { kind: k || (f(r, 'available') === false ? 'unavail' : ''), price, currency };
      continue;
    }
    const rng = parseDateRange(f(r, 'during', 'range', 'period')) ?? { start: str(r, 'startDate', 'start', 'checkIn', 'from'), end: str(r, 'endDate', 'end', 'checkOut', 'to') };
    if (!rng.start || !rng.end) continue;
    const d = new Date(rng.start.slice(0, 10) + 'T00:00:00');
    const end = rng.end.slice(0, 10);
    for (let i = 0; i < 400 && isoDate(d) < end; i++) {
      out[isoDate(d)] = { kind: kindOf(r) || 'unavail', code: str(r, 'reservation.code', 'code', 'label', 'guestName', 'title') || undefined };
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

const KIND_LABEL: Record<Exclude<DayKind, ''>, { short: [string, string]; long: [string, string] }> = {
  paid: { short: ['예약', 'Booked'], long: ['유료 숙박 예약됨', 'paid stay booked'] },
  exchange: { short: ['맞교환', 'Exchange'], long: ['홈 맞교환 예정', 'home exchange'] },
  block: { short: ['차단', 'Blocked'], long: ['호스트가 막은 날짜', 'blocked by host'] },
  hold: { short: ['홀드', 'Hold'], long: ['결제 대기 홀드', 'payment hold'] },
  unavail: { short: ['불가', 'N/A'], long: ['예약 불가', 'unavailable'] },
};

/**
 * Month calendar for availability (host/guide/stay). Accessible as labelled groups of day buttons (no grid role);
 * every day is named with the full localized date + state ("2026년 11월 10일 화요일, 유료 숙박 예약됨, 18만").
 * Shows short kind labels / reservation codes and nightly prices; selected range edges are emphasised.
 */
export function MonthCalendar({
  days,
  selected,
  onSelect,
  legend = true,
  months = 1,
  showPrices = true,
}: {
  days: Record<string, DayInfo>;
  selected?: { start?: string; end?: string };
  onSelect?: (date: string) => void;
  legend?: boolean;
  months?: number;
  showPrices?: boolean;
}) {
  const { lang, L } = useI18n();
  const today = new Date();
  const [offset, setOffset] = useState(0);
  const views = useMemo(() => {
    const arr: Array<{ y: number; m: number }> = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + offset + i, 1);
      arr.push({ y: d.getFullYear(), m: d.getMonth() });
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, months]);
  const dows = lang === 'ko' ? ['일', '월', '화', '수', '목', '금', '토'] : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const todayIso = isoDate(today);
  const inSel = (d: string) => !!selected?.start && (selected.end ? d >= selected.start && d < selected.end : d === selected.start);
  const lastSel = selected?.start && selected.end ? isoDate(new Date(new Date(selected.end + 'T00:00:00').getTime() - 86400000)) : selected?.start;
  const tall = Object.values(days).some((d) => d.label || d.code || d.price || d.kind);
  const fmtMonth = (y: number, m: number) => new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long' }).format(new Date(y, m, 1));

  return (
    <div className="stack">
      <div className="row between">
        <button type="button" className="btn ghost icon sm" onClick={() => setOffset(offset - 1)} aria-label={L('이전 달', 'Previous month')}>
          <Icon name="left" size={18} />
        </button>
        <strong aria-live="polite">{views.map((v) => fmtMonth(v.y, v.m)).join(' · ')}</strong>
        <button type="button" className="btn ghost icon sm" onClick={() => setOffset(offset + 1)} aria-label={L('다음 달', 'Next month')}>
          <Icon name="right" size={18} />
        </button>
      </div>
      <div className={months > 1 ? 'grid-2 even' : ''}>
        {views.map((v) => {
          const grid = weeksOf(v.y, v.m);
          return (
            <div key={`${v.y}-${v.m}`} className={`cal ${tall ? 'tall' : ''}`} role="group" aria-label={fmtMonth(v.y, v.m)}>
              {dows.map((d, i) => (
                <div key={d} className={`dow ${i === 0 ? 'sun' : ''}`} aria-hidden="true">
                  {d}
                </div>
              ))}
              {grid.map((d) => {
                const info = days[d];
                const out = Number(d.slice(5, 7)) - 1 !== v.m;
                if (out) return <div key={d} className="day out" aria-hidden="true" />;
                const past = d < todayIso;
                const sel = inSel(d);
                const kind = info?.kind || '';
                const shortLabel = info?.label ?? info?.code ?? (kind ? pickPair(KIND_LABEL[kind].short, lang) : '');
                const stateText = info?.label ?? (kind ? pickPair(KIND_LABEL[kind].long, lang) : '');
                const price = showPrices && info?.price && !past && (kind === '' || kind === 'block') ? formatPriceShort(info.price, info.currency || 'KRW', lang) : '';
                const cls = ['day', kind, sel ? 'sel' : '', sel && d === selected?.start ? 'edge-start' : '', sel && d === lastSel ? 'edge-end' : '', d === todayIso ? 'today' : ''].filter(Boolean).join(' ');
                const name = [formatDateLong(d, lang), stateText, info?.code ?? '', price, sel ? L('선택됨', 'selected') : '', past ? L('지난 날짜', 'past') : '']
                  .filter(Boolean)
                  .join(', ');
                const content = (
                  <>
                    <span aria-hidden="true">{Number(d.slice(8))}</span>
                    {shortLabel && (
                      <span className="lbl" aria-hidden="true">
                        {shortLabel}
                      </span>
                    )}
                    {price && (
                      <span className="price" aria-hidden="true">
                        {price}
                      </span>
                    )}
                  </>
                );
                return onSelect ? (
                  <button key={d} type="button" className={cls} disabled={past} aria-disabled={past || undefined} onClick={() => onSelect(d)} aria-label={name} aria-pressed={sel}>
                    {content}
                  </button>
                ) : (
                  <div key={d} className={cls}>
                    {content}
                    <span className="sr-only">{name}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {legend && (
        <div className="legend" aria-label={L('범례', 'Legend')}>
          <span>
            <i style={{ background: 'var(--c-paid)' }} />
            {L('유료 숙박', 'Paid stay')}
          </span>
          <span>
            <i style={{ background: 'var(--c-exchange)' }} />
            {L('홈 맞교환', 'Exchange')}
          </span>
          <span>
            <i style={{ background: 'var(--c-block)' }} />
            {L('호스트 차단', 'Host block')}
          </span>
          <span>
            <i style={{ background: 'var(--c-hold)' }} />
            {L('결제 대기 홀드', 'Hold')}
          </span>
        </div>
      )}
    </div>
  );
}
