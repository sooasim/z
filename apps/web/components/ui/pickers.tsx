'use client';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { addDays, formatDate, isoDate, monthGrid, nightsBetween } from '@/lib/format';
import { get } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { Icon } from './icons';

/** Close a popover on outside click / Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function Qty({ value, onChange, min = 0, max = 16, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  const { L } = useI18n();
  return (
    <div className="qty" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`${label} ${L('감소', 'decrease')}`}>
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`${label} ${L('증가', 'increase')}`}>
        +
      </button>
    </div>
  );
}

export interface Guests {
  adults: number;
  children: number;
  infants: number;
  pets: number;
}
export const guestTotal = (g: Guests) => g.adults + g.children;

export function GuestsPanel({ value, onChange, max = 16, pets = true }: { value: Guests; onChange: (g: Guests) => void; max?: number; pets?: boolean }) {
  const { L } = useI18n();
  const rows: Array<[keyof Guests, string, string, number]> = [
    ['adults', L('성인', 'Adults'), L('13세 이상', 'Ages 13+'), 1],
    ['children', L('어린이', 'Children'), L('2~12세', 'Ages 2–12'), 0],
    ['infants', L('유아', 'Infants'), L('2세 미만', 'Under 2'), 0],
  ];
  if (pets) rows.push(['pets', L('반려동물', 'Pets'), L('보조견은 언제나 환영', 'Service animals always welcome'), 0]);
  return (
    <div style={{ minWidth: 300 }}>
      {rows.map(([k, label, hint, min]) => (
        <div key={k} className="guest-row">
          <div>
            <strong>{label}</strong>
            <div className="xs muted">{hint}</div>
          </div>
          <Qty label={label} value={value[k]} min={min} max={k === 'adults' || k === 'children' ? Math.max(min, max - (k === 'adults' ? value.children : value.adults)) : 5} onChange={(n) => onChange({ ...value, [k]: n })} />
        </div>
      ))}
    </div>
  );
}

export function guestsLabel(g: Guests, L: (ko: string, en: string) => string) {
  const t = guestTotal(g);
  const parts = [`${L('게스트', 'Guests')} ${t}${L('명', '')}`];
  if (g.infants) parts.push(`${L('유아', 'Infants')} ${g.infants}`);
  if (g.pets) parts.push(`${L('반려동물', 'Pets')} ${g.pets}`);
  return parts.join(', ');
}

export function GuestsField({ value, onChange, max, compact }: { value: Guests; onChange: (g: Guests) => void; max?: number; compact?: boolean }) {
  const { L } = useI18n();
  const p = usePopover();
  const id = useId();
  return (
    <div className="popover-anchor" ref={p.ref}>
      <button type="button" className="search-slot" aria-expanded={p.open} aria-controls={id} onClick={() => p.setOpen(!p.open)}>
        <span className="k">{L('인원', 'Who')}</span>
        <span className="v">{compact ? `${guestTotal(value)}${L('명', '')}` : guestsLabel(value, L)}</span>
      </button>
      {p.open && (
        <div className="popover right" id={id} role="dialog" aria-label={L('인원 선택', 'Guests')}>
          <GuestsPanel value={value} onChange={onChange} max={max} />
        </div>
      )}
    </div>
  );
}

/** Range calendar (half-open nights). `isBlocked(date)` marks unavailable nights; a range may not span a blocked night. */
export function RangeCalendar({ start, end, onChange, isBlocked, months = 2, minDate, priceFor }: { start: string; end: string; onChange: (r: { start: string; end: string }) => void; isBlocked?: (d: string) => boolean; months?: 1 | 2; minDate?: string; priceFor?: (d: string) => string | undefined }) {
  const { lang, L } = useI18n();
  const today = minDate ?? isoDate(new Date());
  const [offset, setOffset] = useState(() => {
    if (!start) return 0;
    const s = new Date(start + 'T00:00:00');
    const n = new Date();
    return (s.getFullYear() - n.getFullYear()) * 12 + s.getMonth() - n.getMonth();
  });
  const [hover, setHover] = useState('');
  const views = useMemo(() => {
    const n = new Date();
    return Array.from({ length: months }, (_, i) => {
      const d = new Date(n.getFullYear(), n.getMonth() + offset + i, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }, [offset, months]);
  const dows = lang === 'ko' ? ['일', '월', '화', '수', '목', '금', '토'] : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const spansBlocked = (a: string, b: string) => {
    if (!isBlocked) return false;
    for (let d = a; d < b; d = addDays(d, 1)) if (isBlocked(d)) return true;
    return false;
  };
  const pick = (d: string) => {
    if (!start || (start && end) || d <= start) onChange({ start: d, end: '' });
    else if (spansBlocked(start, d)) onChange({ start: d, end: '' });
    else onChange({ start, end: d });
  };
  const previewEnd = start && !end && hover > start && !spansBlocked(start, hover) ? hover : end;
  return (
    <div className="stack">
      <div className="row between">
        <button type="button" className="btn ghost icon sm" onClick={() => setOffset(offset - 1)} disabled={offset <= 0} aria-label={L('이전 달', 'Previous month')}>
          <Icon name="left" size={18} />
        </button>
        <span className="small muted" aria-live="polite">
          {start && end ? `${formatDate(start, lang)} → ${formatDate(end, lang)} · ${nightsBetween(start, end)}${L('박', ' nights')}` : start ? L('체크아웃 날짜를 선택하세요', 'Select check-out') : L('체크인 날짜를 선택하세요', 'Select check-in')}
        </span>
        <button type="button" className="btn ghost icon sm" onClick={() => setOffset(offset + 1)} aria-label={L('다음 달', 'Next month')}>
          <Icon name="right" size={18} />
        </button>
      </div>
      <div className={`cal-months ${months === 2 ? 'two' : ''}`}>
        {views.map((v) => (
          <div key={`${v.y}-${v.m}`}>
            <div className="cal-title">{new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long' }).format(new Date(v.y, v.m, 1))}</div>
            <div className="cal" role="grid" onMouseLeave={() => setHover('')}>
              {dows.map((d) => (
                <div key={d} className="dow" role="columnheader">
                  {d}
                </div>
              ))}
              {monthGrid(v.y, v.m).map((d) => {
                const out = Number(d.slice(5, 7)) - 1 !== v.m;
                if (out) return <div key={d} className="day out" aria-hidden="true" />;
                const selectingEnd = !!start && !end;
                const blockedNight = !!isBlocked?.(d);
                const disabled = d < today || (selectingEnd && d > start ? spansBlocked(start, d) : blockedNight);
                const isEdge = d === start || d === (previewEnd || '');
                const inRange = start && previewEnd && d > start && d < previewEnd;
                const price = priceFor?.(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className={`day ${isEdge ? 'edge' : ''} ${inRange ? 'sel' : ''} ${disabled && blockedNight ? 'unavail' : ''}`}
                    disabled={disabled}
                    aria-pressed={isEdge || !!inRange}
                    aria-label={`${formatDate(d, lang)}${disabled ? ' ' + L('선택 불가', 'unavailable') : ''}`}
                    onMouseEnter={() => setHover(d)}
                    onFocus={() => setHover(d)}
                    onClick={() => pick(d)}
                  >
                    {Number(d.slice(8))}
                    {price && !disabled && <span className="price">{price}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="row between">
        <button type="button" className="btn link sm" onClick={() => onChange({ start: '', end: '' })}>
          {L('날짜 지우기', 'Clear dates')}
        </button>
      </div>
    </div>
  );
}

export function DateRangeField({ start, end, onChange, isBlocked, labels, boxed }: { start: string; end: string; onChange: (r: { start: string; end: string }) => void; isBlocked?: (d: string) => boolean; labels?: [string, string]; boxed?: boolean }) {
  const { L, lang } = useI18n();
  const p = usePopover();
  const id = useId();
  const [inL, outL] = labels ?? [L('체크인', 'Check in'), L('체크아웃', 'Check out')];
  const slots = (
    <>
      <button type="button" className="search-slot" aria-expanded={p.open} aria-controls={id} onClick={() => p.setOpen(true)}>
        <span className="k">{inL}</span>
        <span className="v">{start ? formatDate(start, lang) : L('날짜 추가', 'Add dates')}</span>
      </button>
      <button type="button" className="search-slot" aria-expanded={p.open} aria-controls={id} onClick={() => p.setOpen(true)}>
        <span className="k">{outL}</span>
        <span className="v">{end ? formatDate(end, lang) : L('날짜 추가', 'Add dates')}</span>
      </button>
    </>
  );
  return (
    <div className="popover-anchor" ref={p.ref}>
      <div className={boxed ? 'date-box' : ''} style={boxed ? undefined : { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {slots}
      </div>
      {p.open && (
        <div className="popover" id={id} role="dialog" aria-label={L('날짜 선택', 'Choose dates')} style={{ width: 'min(720px, calc(100vw - 32px))' }}>
          <RangeCalendar
            start={start}
            end={end}
            isBlocked={isBlocked}
            onChange={(r) => {
              onChange(r);
              if (r.start && r.end) p.setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

const POPULAR: Array<{ ko: string; en: string; icon: string; hint: [string, string] }> = [
  { ko: '제주', en: 'Jeju', icon: '🌊', hint: ['한달살기 인기', 'Top for month stays'] },
  { ko: '서울', en: 'Seoul', icon: '🏙', hint: ['도시 생활', 'City life'] },
  { ko: '부산', en: 'Busan', icon: '⛱', hint: ['바다 앞 워케이션', 'Seaside workation'] },
  { ko: '강릉', en: 'Gangneung', icon: '☕', hint: ['커피와 바다', 'Coffee & coast'] },
  { ko: '경주', en: 'Gyeongju', icon: '🏯', hint: ['역사 도시', 'Historic city'] },
  { ko: '치앙마이', en: 'Chiang Mai', icon: '🌴', hint: ['디지털 노마드', 'Digital nomads'] },
  { ko: '도쿄', en: 'Tokyo', icon: '🗼', hint: ['맞교환 수요 많음', 'Popular for exchange'] },
  { ko: '리스본', en: 'Lisbon', icon: '🚋', hint: ['유럽 한달살기', 'Month in Europe'] },
];

/** Destination combobox: popular places + API suggestions (`/v1/search/suggest`, optional). */
export function DestinationInput({ value, onChange, onPick, label, placeholder }: { value: string; onChange: (v: string) => void; onPick?: (v: string) => void; label?: ReactNode; placeholder?: string }) {
  const { L, lang } = useI18n();
  const p = usePopover();
  const id = useId();
  const [active, setActive] = useState(-1);
  const [remote, setRemote] = useState<string[]>([]);
  useEffect(() => {
    if (!value || value.length < 2) {
      setRemote([]);
      return;
    }
    const t = setTimeout(() => {
      get('/v1/search/suggest', { q: value, limit: 5 })
        .then((r: any) => {
          const list = [
            ...(Array.isArray(r?.places) ? r.places.map((x: any) => str(x, lang === 'ko' ? 'label' : 'labelEn', 'label')) : []),
            ...(Array.isArray(r?.cities) ? r.cities.map((x: any) => (typeof x === 'string' ? x : str(x, 'city', 'label', 'name'))) : []),
            ...items(r).map((x: any) => (typeof x === 'string' ? x : str(x, 'label', 'name', 'city'))),
          ].filter(Boolean);
          setRemote(Array.from(new Set(list)).slice(0, 5));
        })
        .catch(() => setRemote([]));
    }, 220);
    return () => clearTimeout(t);
  }, [value, lang]);
  const q = value.trim().toLowerCase();
  const local = POPULAR.filter((x) => !q || x.ko.includes(value.trim()) || x.en.toLowerCase().includes(q));
  const options = [...remote.map((r) => ({ text: r, icon: '📍', hint: '' })), ...local.map((x) => ({ text: x[lang], icon: x.icon, hint: x.hint[lang === 'ko' ? 0 : 1] }))].slice(0, 8);
  const choose = (t: string) => {
    onChange(t);
    onPick?.(t);
    p.setOpen(false);
  };
  return (
    <div className="popover-anchor" ref={p.ref}>
      <label className="search-slot" htmlFor={`${id}-in`} style={{ cursor: 'text' }}>
        <span className="k">{label ?? L('여행지', 'Where')}</span>
        <input
          id={`${id}-in`}
          role="combobox"
          aria-expanded={p.open}
          aria-controls={`${id}-lb`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          autoComplete="off"
          value={value}
          placeholder={placeholder ?? L('여행지 검색', 'Search destinations')}
          onFocus={() => p.setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            p.setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              p.setOpen(true);
              setActive((a) => Math.min(options.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(-1, a - 1));
            } else if (e.key === 'Enter' && p.open && active >= 0) {
              e.preventDefault();
              choose(options[active].text);
            }
          }}
        />
      </label>
      {p.open && options.length > 0 && (
        <div className="popover" style={{ width: 'min(400px, calc(100vw - 32px))', padding: 8 }}>
          {!q && <div className="xs muted" style={{ padding: '6px 12px', fontWeight: 700 }}>{L('인기 여행지', 'Popular destinations')}</div>}
          <ul className="listbox" role="listbox" id={`${id}-lb`}>
            {options.map((o, i) => (
              <li key={o.text + i} id={`${id}-o${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o.text)}>
                <span className="ico" aria-hidden="true">{o.icon}</span>
                <span>
                  <strong className="small">{o.text}</strong>
                  {o.hint && <div className="xs muted">{o.hint}</div>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
