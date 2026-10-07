'use client';
import { useMemo, useState } from 'react';
import { monthGrid, isoDate, parseDateRange } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { f, str } from '@/lib/shape';

export type DayKind = 'paid' | 'exchange' | 'block' | 'hold' | 'unavail' | '';

/** Normalise calendar API rows → map of date → kind. Accepts per-day rows or ranges (start/end or daterange). */
export function calendarDays(rows: any[]): Record<string, { kind: DayKind; label?: string; price?: number }> {
  const out: Record<string, { kind: DayKind; label?: string; price?: number }> = {};
  const kindOf = (r: any): DayKind => {
    const t = (str(r, 'blockType', 'type', 'kind', 'source', 'reason', 'status') || '').toUpperCase();
    if (t.includes('EXCHANGE')) return 'exchange';
    if (t.includes('HOLD')) return 'hold';
    if (t.includes('RESERV') || t.includes('BOOK') || t.includes('PAID')) return 'paid';
    if (t.includes('HOST') || t.includes('BLOCK') || t.includes('MANUAL') || t.includes('OWNER')) return 'block';
    if (f(r, 'available') === false || t === 'UNAVAILABLE' || t === 'BLOCKED') return 'unavail';
    return '';
  };
  for (const r of rows) {
    const date = str(r, 'date', 'day');
    if (date) {
      const blk = f<any>(r, 'block');
      if (blk) {
        out[date.slice(0, 10)] = { kind: kindOf({ type: str(blk, 'type', 'blockType') }) || 'block', label: str(blk, 'reservation.code', 'sourceType') || undefined };
        continue;
      }
      const st = (str(r, 'status', 'availability') || '').toUpperCase();
      if (st === 'BOOKED' || st === 'BLOCKED' || st === 'UNAVAILABLE') {
        out[date.slice(0, 10)] = { kind: 'unavail', price: Number(f(r, 'priceMinor')) || undefined };
        continue;
      }
      const k = st === 'AVAILABLE' ? '' : kindOf(r);
      out[date.slice(0, 10)] = { kind: k || (f(r, 'available') === false ? 'unavail' : ''), price: Number(f(r, 'priceMinor', 'nightlyPriceMinor')) || undefined };
      continue;
    }
    const rng = parseDateRange(f(r, 'during', 'range', 'period')) ?? { start: str(r, 'startDate', 'start', 'checkIn', 'from'), end: str(r, 'endDate', 'end', 'checkOut', 'to') };
    if (!rng.start || !rng.end) continue;
    const d = new Date(rng.start.slice(0, 10) + 'T00:00:00');
    const end = rng.end.slice(0, 10);
    for (let i = 0; i < 400 && isoDate(d) < end; i++) {
      out[isoDate(d)] = { kind: kindOf(r) || 'unavail', label: str(r, 'label', 'guestName', 'title') };
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

export function MonthCalendar({
  days,
  selected,
  onSelect,
  legend = true,
  months = 1,
}: {
  days: Record<string, { kind: DayKind; label?: string; price?: number }>;
  selected?: { start?: string; end?: string };
  onSelect?: (date: string) => void;
  legend?: boolean;
  months?: number;
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
  const inSel = (d: string) => selected?.start && (selected.end ? d >= selected.start && d < selected.end : d === selected.start);

  return (
    <div className="stack">
      <div className="row between">
        <button className="btn sm" onClick={() => setOffset(offset - 1)} aria-label={L('이전 달', 'Previous month')}>
          ‹
        </button>
        <strong aria-live="polite">{views.map((v) => new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long' }).format(new Date(v.y, v.m, 1))).join(' · ')}</strong>
        <button className="btn sm" onClick={() => setOffset(offset + 1)} aria-label={L('다음 달', 'Next month')}>
          ›
        </button>
      </div>
      <div className={months > 1 ? 'grid-2 even' : ''}>
        {views.map((v) => {
          const grid = monthGrid(v.y, v.m);
          return (
            <div key={`${v.y}-${v.m}`} className="cal" role="grid">
              {dows.map((d) => (
                <div key={d} className="dow" role="columnheader">
                  {d}
                </div>
              ))}
              {grid.map((d) => {
                const info = days[d];
                const out = Number(d.slice(5, 7)) - 1 !== v.m;
                const past = d < todayIso;
                const cls = ['day', out ? 'out' : '', info?.kind ?? '', inSel(d) ? 'sel' : ''].join(' ');
                const content = (
                  <>
                    <span>{Number(d.slice(8))}</span>
                    {info?.label && <div className="small" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{info.label}</div>}
                  </>
                );
                return onSelect && !out ? (
                  <button key={d} type="button" className={cls} disabled={past} onClick={() => onSelect(d)} aria-label={`${d}${info?.kind ? ' ' + info.kind : ''}`} aria-pressed={!!inSel(d)}>
                    {content}
                  </button>
                ) : (
                  <div key={d} className={cls} role="gridcell" aria-label={`${d}${info?.kind ? ' ' + info.kind : ''}`}>
                    {content}
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
