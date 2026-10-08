'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { addDays, formatDate, formatDateLong, formatRange, isoDate, monthWeeks as weeksOf, nightsBetween } from '@/lib/format';
import { get } from '@/lib/api';
import { items, str, num } from '@/lib/shape';
import { canonicalPlace, findPlace, placeLabel } from '@/lib/places';
import { Icon, type IconName } from './icons';
import { Modal } from './modal';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Reactive `matchMedia` (false during SSR / first render). */
export function useMediaQuery(query: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/**
 * Popover state: closes on outside pointer-down, Escape (focus returns to the trigger) and when keyboard focus
 * leaves the anchor (WCAG 2.4.11 — an open listbox must not hide the next focused control). Content rendered in a
 * portal (sheets) should get `portalRef` so it counts as "inside".
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const inside = (n: Node | null) => !!n && (!!el?.contains(n) || !!portalRef.current?.contains(n));
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const hadFocus = inside(document.activeElement);
      setOpen(false);
      if (hadFocus) el?.querySelector<HTMLElement>('[aria-expanded], button, input')?.focus();
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      // null relatedTarget = focus went to the page/body or another window: pointer handler decides.
      if (next && !inside(next)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    el?.addEventListener('focusout', onFocusOut);
    portalRef.current?.addEventListener('focusout', onFocusOut);
    const portal = portalRef.current;
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      el?.removeEventListener('focusout', onFocusOut);
      portal?.removeEventListener('focusout', onFocusOut);
    };
  }, [open]);
  return { open, setOpen, ref, portalRef };
}

function hasStickyAncestor(el: HTMLElement | null): boolean {
  for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
    const p = getComputedStyle(n).position;
    if (p === 'sticky' || p === 'fixed') return true;
  }
  return false;
}

/**
 * Keeps an absolutely positioned popover inside the viewport: shifts it horizontally (16px gutters) and, when it
 * sits in a sticky/fixed container (which the page cannot scroll), caps its height and lets it scroll internally.
 */
export function useFitPopover(open: boolean, pop: RefObject<HTMLElement | null>) {
  useIsoLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const el = pop.current;
      if (!el) return;
      el.style.translate = '';
      el.style.maxHeight = '';
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const g = 16;
      let dx = 0;
      if (r.right > vw - g) dx = vw - g - r.right;
      if (r.left + dx < g) dx = g - r.left;
      if (dx) el.style.translate = `${Math.round(dx)}px 0`;
      if (hasStickyAncestor(el)) {
        const avail = window.innerHeight - r.top - 12;
        if (r.height > avail && avail > 160) {
          el.style.maxHeight = `${Math.floor(avail)}px`;
          el.style.overflowY = 'auto';
        }
      }
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);
}

export function Qty({ value, onChange, min = 0, max = 16, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  const { L } = useI18n();
  return (
    <div className="qty" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`${label} ${L('감소', 'decrease')}`}>
        <Icon name="minus" size={16} />
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`${label} ${L('증가', 'increase')}`}>
        <Icon name="plus" size={16} />
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
    <div style={{ minWidth: 'min(300px, 100%)' }}>
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

export function GuestsField({ value, onChange, max, compact, pets }: { value: Guests; onChange: (g: Guests) => void; max?: number; compact?: boolean; pets?: boolean }) {
  const { L } = useI18n();
  const p = usePopover();
  const id = useId();
  const popRef = useRef<HTMLDivElement>(null);
  useFitPopover(p.open, popRef);
  return (
    <div className="popover-anchor" ref={p.ref}>
      <button type="button" className="search-slot" aria-expanded={p.open} aria-controls={id} aria-haspopup="dialog" onClick={() => p.setOpen(!p.open)}>
        <span className="k">{L('인원', 'Who')}</span>
        <span className="v">{compact ? `${guestTotal(value)}${L('명', '')}` : guestsLabel(value, L)}</span>
      </button>
      {p.open && (
        <div className="popover right" id={id} ref={popRef} role="dialog" aria-label={L('인원 선택', 'Guests')}>
          <GuestsPanel value={value} onChange={onChange} max={max} pets={pets} />
        </div>
      )}
    </div>
  );
}

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DOW_EN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * Range calendar (half-open nights). `isBlocked(date)` marks unavailable nights; a range may not span a blocked night.
 * Accessible as labelled groups of day buttons (no grid role): each button's name is the full localized date plus its
 * state; ←/→/↑/↓/Home/End/PageUp/PageDown move focus between days and months.
 */
export function RangeCalendar({ start, end, onChange, isBlocked, months = 2, minDate, priceFor, hideClear }: { start: string; end: string; onChange: (r: { start: string; end: string }) => void; isBlocked?: (d: string) => boolean; months?: 1 | 2; minDate?: string; priceFor?: (d: string) => string | undefined; hideClear?: boolean }) {
  const { lang, L } = useI18n();
  const today = minDate ?? isoDate(new Date());
  const [offset, setOffset] = useState(() => {
    if (!start) return 0;
    const s = new Date(start + 'T00:00:00');
    const n = new Date();
    return Math.max(0, (s.getFullYear() - n.getFullYear()) * 12 + s.getMonth() - n.getMonth());
  });
  const [hover, setHover] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const views = useMemo(() => {
    const n = new Date();
    return Array.from({ length: months }, (_, i) => {
      const d = new Date(n.getFullYear(), n.getMonth() + offset + i, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }, [offset, months]);
  const dows = lang === 'ko' ? DOW_KO : DOW_EN;
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

  useEffect(() => {
    const d = pendingFocus.current;
    if (!d) return;
    const el = rootRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${d}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });
  const monthIndex = (d: string) => {
    const n = new Date();
    return (Number(d.slice(0, 4)) - n.getFullYear()) * 12 + Number(d.slice(5, 7)) - 1 - n.getMonth();
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const cur = t.getAttribute?.('data-date');
    if (!cur) return;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = '';
    if (step[e.key] !== undefined) next = addDays(cur, step[e.key]);
    else if (e.key === 'Home') next = addDays(cur, -new Date(cur + 'T00:00:00').getDay());
    else if (e.key === 'End') next = addDays(cur, 6 - new Date(cur + 'T00:00:00').getDay());
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const d = new Date(cur + 'T00:00:00');
      d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
      next = isoDate(d);
    } else return;
    e.preventDefault();
    if (next < today) next = today;
    const mi = monthIndex(next);
    if (mi < offset) setOffset(Math.max(0, mi));
    else if (mi > offset + months - 1) setOffset(mi - months + 1);
    pendingFocus.current = next;
    rootRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${next}"]`)?.focus();
  };
  // One tab stop per calendar: the start date, else today (or first selectable day of the first visible month).
  const firstVisible = `${views[0].y}-${String(views[0].m + 1).padStart(2, '0')}-01`;
  const tabStop = start && monthIndex(start) >= offset && monthIndex(start) < offset + months ? start : today >= firstVisible && monthIndex(today) === offset ? today : firstVisible;

  return (
    <div className="stack" ref={rootRef}>
      <div className="row between">
        <button type="button" className="btn ghost icon sm" onClick={() => setOffset(offset - 1)} disabled={offset <= 0} aria-label={L('이전 달', 'Previous month')}>
          <Icon name="left" size={18} />
        </button>
        <span className="small muted" aria-live="polite">
          {start && end ? formatRange(start, end, lang, { nights: true }) : start ? L('체크아웃 날짜를 선택하세요', 'Select check-out') : L('체크인 날짜를 선택하세요', 'Select check-in')}
        </span>
        <button type="button" className="btn ghost icon sm" onClick={() => setOffset(offset + 1)} aria-label={L('다음 달', 'Next month')}>
          <Icon name="right" size={18} />
        </button>
      </div>
      <div className={`cal-months ${months === 2 ? 'two' : ''}`} onKeyDown={onKey}>
        {views.map((v) => {
          const title = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long' }).format(new Date(v.y, v.m, 1));
          return (
            <div key={`${v.y}-${v.m}`}>
              <div className="cal-title" aria-hidden="true">
                {title}
              </div>
              <div className="cal" role="group" aria-label={title} onMouseLeave={() => setHover('')}>
                {dows.map((d, i) => (
                  <div key={d} className={`dow ${i === 0 ? 'sun' : ''}`} aria-hidden="true">
                    {d}
                  </div>
                ))}
                {weeksOf(v.y, v.m).map((d) => {
                  const out = Number(d.slice(5, 7)) - 1 !== v.m;
                  if (out) return <div key={d} className="day out" aria-hidden="true" />;
                  const selectingEnd = !!start && !end;
                  const blockedNight = !!isBlocked?.(d);
                  const past = d < today;
                  const disabled = past || (selectingEnd && d > start ? spansBlocked(start, d) : blockedNight);
                  const isEdge = d === start || d === (previewEnd || '');
                  const inRange = !!(start && previewEnd && d > start && d < previewEnd);
                  const price = priceFor?.(d);
                  const state = d === start ? L('체크인', 'check-in') : d === end ? L('체크아웃', 'check-out') : inRange && end ? L('선택한 기간', 'in selected range') : past ? L('지난 날짜', 'past date') : disabled ? L('예약 불가', 'unavailable') : '';
                  return (
                    <button
                      key={d}
                      type="button"
                      data-date={d}
                      className={`day ${isEdge ? 'edge' : ''} ${inRange ? 'sel' : ''} ${disabled && blockedNight ? 'unavail' : ''} ${d === isoDate(new Date()) ? 'today' : ''}`}
                      disabled={disabled}
                      tabIndex={d === tabStop ? 0 : -1}
                      aria-pressed={isEdge || inRange}
                      aria-label={`${formatDateLong(d, lang)}${state ? ', ' + state : ''}${price && !disabled ? `, ${price}` : ''}`}
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
          );
        })}
      </div>
      {!hideClear && (
        <div className="row between">
          <button type="button" className="btn link sm" onClick={() => onChange({ start: '', end: '' })} disabled={!start && !end}>
            {L('날짜 지우기', 'Clear dates')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Check-in / check-out slots + range calendar.
 * - ≥640px: popover; it stays inside the viewport (auto-shift), `align="right"` anchors it to the right edge.
 *   `months` defaults to 2 from 760px, else 1.
 * - <640px (or `sheet`): bottom sheet with one month and a "done" button.
 */
export function DateRangeField({
  start,
  end,
  onChange,
  isBlocked,
  labels,
  boxed,
  align = 'auto',
  months,
  sheet,
  priceFor,
  minDate,
}: {
  start: string;
  end: string;
  onChange: (r: { start: string; end: string }) => void;
  isBlocked?: (d: string) => boolean;
  labels?: [string, string];
  boxed?: boolean;
  align?: 'auto' | 'left' | 'right';
  months?: 1 | 2;
  /** true: always a sheet; false: never; default: below 640px. */
  sheet?: boolean;
  priceFor?: (d: string) => string | undefined;
  minDate?: string;
}) {
  const { L, lang } = useI18n();
  const p = usePopover();
  const id = useId();
  const wide = useMediaQuery('(min-width: 760px)');
  const phone = useMediaQuery('(max-width: 639px)');
  const asSheet = sheet ?? phone;
  const popRef = useRef<HTMLDivElement>(null);
  useFitPopover(p.open && !asSheet, popRef);
  const m: 1 | 2 = months ?? (wide ? 2 : 1);
  const [inL, outL] = labels ?? [L('체크인', 'Check in'), L('체크아웃', 'Check out')];
  const close = useCallback(() => p.setOpen(false), [p]);
  const slots = (
    <>
      <button type="button" className="search-slot" aria-expanded={p.open} aria-controls={id} aria-haspopup="dialog" onClick={() => p.setOpen(true)}>
        <span className="k">{inL}</span>
        <span className={`v ${start ? '' : 'ph'}`}>{start ? formatDate(start, lang) : L('날짜 추가', 'Add dates')}</span>
      </button>
      <button type="button" className="search-slot" aria-expanded={p.open} aria-controls={id} aria-haspopup="dialog" onClick={() => p.setOpen(true)}>
        <span className="k">{outL}</span>
        <span className={`v ${end ? '' : 'ph'}`}>{end ? formatDate(end, lang) : L('날짜 추가', 'Add dates')}</span>
      </button>
    </>
  );
  const nights = nightsBetween(start, end);
  const cal = (mm: 1 | 2, hideClear?: boolean) => (
    <RangeCalendar
      start={start}
      end={end}
      isBlocked={isBlocked}
      months={mm}
      priceFor={priceFor}
      minDate={minDate}
      hideClear={hideClear}
      onChange={(r) => {
        onChange(r);
        if (r.start && r.end && !asSheet) p.setOpen(false);
      }}
    />
  );
  return (
    <div className="popover-anchor" ref={p.ref}>
      <div className={boxed ? 'date-box' : 'date-range-slots'}>{slots}</div>
      {p.open && !asSheet && (
        <div ref={popRef} className={`popover ${align === 'right' ? 'right' : ''}`} id={id} role="dialog" aria-label={L('날짜 선택', 'Choose dates')} style={{ width: m === 2 ? 'min(720px, calc(100vw - 32px))' : 'min(380px, calc(100vw - 32px))' }}>
          {cal(m)}
        </div>
      )}
      {asSheet && (
        <Modal
          open={p.open}
          onClose={close}
          panelRef={p.portalRef}
          title={L('날짜 선택', 'Choose dates')}
          footer={
            <>
              <button type="button" className="btn link sm" onClick={() => onChange({ start: '', end: '' })} disabled={!start && !end}>
                {L('지우기', 'Clear')}
              </button>
              <button type="button" className="btn primary" onClick={close}>
                {nights > 0 ? L(`${nights}박 선택 완료`, `Done · ${nights} night${nights === 1 ? '' : 's'}`) : L('완료', 'Done')}
              </button>
            </>
          }
        >
          <div id={id}>{cal(1, true)}</div>
        </Modal>
      )}
    </div>
  );
}

const POPULAR: Array<{ ko: string; en: string; art: string; hint: [string, string] }> = [
  { ko: '제주', en: 'Jeju', art: 'jeju', hint: ['한달살기 인기', 'Top for month stays'] },
  { ko: '서울', en: 'Seoul', art: 'seoul', hint: ['도시 생활', 'City life'] },
  { ko: '부산', en: 'Busan', art: 'busan', hint: ['바다 앞 워케이션', 'Seaside workation'] },
  { ko: '강릉', en: 'Gangneung', art: 'gangneung', hint: ['커피와 바다', 'Coffee & coast'] },
  { ko: '경주', en: 'Gyeongju', art: 'gyeongju', hint: ['역사 도시', 'Historic city'] },
  { ko: '치앙마이', en: 'Chiang Mai', art: 'chiangmai', hint: ['디지털 노마드', 'Digital nomads'] },
  { ko: '도쿄', en: 'Tokyo', art: 'tokyo', hint: ['맞교환 수요 많음', 'Popular for exchange'] },
  { ko: '리스본', en: 'Lisbon', art: 'lisbon', hint: ['유럽 한달살기', 'Month in Europe'] },
];

/** A destination suggestion: `label` is shown, `value` is the canonical (API) name sent in searches. */
export interface PlaceOption {
  label: string;
  value: string;
  hint?: string;
  icon?: IconName;
  art?: string;
  lat?: number;
  lng?: number;
  kind?: 'place' | 'city' | 'title' | 'popular';
}

/**
 * Destination combobox: popular places + API suggestions (`/v1/search/suggest`). `value`/`onChange` carry the
 * text the user sees (e.g. "제주"); `onPick(canonical, option)` receives the canonical API value ("Jeju") with
 * coordinates when known. Options are de-duplicated by canonical value. `inline` renders the list in flow (sheets).
 */
export function DestinationInput({ value, onChange, onPick, label, placeholder, inline, autoFocus }: { value: string; onChange: (v: string) => void; onPick?: (value: string, option: PlaceOption) => void; label?: ReactNode; placeholder?: string; inline?: boolean; autoFocus?: boolean }) {
  const { L, lang } = useI18n();
  const p = usePopover();
  const id = useId();
  const popRef = useRef<HTMLDivElement>(null);
  useFitPopover(p.open && !inline, popRef);
  const [active, setActive] = useState(-1);
  const [remote, setRemote] = useState<PlaceOption[]>([]);
  useEffect(() => {
    if (!value || value.trim().length < 1 || (value.trim().length < 2 && !/[가-힣]/.test(value))) {
      setRemote([]);
      return;
    }
    const t = setTimeout(() => {
      get('/v1/search/suggest', { q: value.trim(), limit: 6 })
        .then((r: any) => {
          const list: PlaceOption[] = [
            ...(Array.isArray(r?.places)
              ? r.places.map((x: any) => {
                  const en = str(x, 'labelEn') || str(x, 'label');
                  return { label: lang === 'ko' ? str(x, 'label') || placeLabel(en, 'ko') : en, value: en, lat: num(x, 'lat'), lng: num(x, 'lng'), icon: 'pin' as IconName, kind: 'place' as const, art: findPlace(en)?.art };
                })
              : []),
            ...(Array.isArray(r?.cities)
              ? r.cities.map((x: any) => {
                  const c = typeof x === 'string' ? x : str(x, 'city', 'label', 'name');
                  const count = typeof x === 'object' ? num(x, 'count') : undefined;
                  return { label: placeLabel(c, lang), value: canonicalPlace(c), hint: count ? L(`숙소 ${count}곳`, `${count} stays`) : undefined, icon: 'pin' as IconName, kind: 'city' as const, art: findPlace(c)?.art };
                })
              : []),
            ...[...(Array.isArray(r?.titles) ? r.titles : []), ...items(r)].map((x: any) => {
              const t = typeof x === 'string' ? x : str(x, 'title', 'label', 'name');
              return { label: t, value: t, icon: 'home' as IconName, kind: 'title' as const };
            }),
          ].filter((o) => o.label && o.value);
          setRemote(list);
        })
        .catch(() => setRemote([]));
    }, 200);
    return () => clearTimeout(t);
  }, [value, lang, L]);
  const q = value.trim().toLowerCase();
  const local: PlaceOption[] = POPULAR.filter((x) => !q || x.ko.includes(value.trim()) || x.en.toLowerCase().includes(q)).map((x) => ({ label: x[lang], value: x.en, art: x.art, hint: x.hint[lang === 'ko' ? 0 : 1], kind: 'popular', ...(findPlace(x.en) ? { lat: findPlace(x.en)!.lat, lng: findPlace(x.en)!.lng } : {}) }));
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: PlaceOption[] = [];
    for (const o of [...remote, ...local]) {
      const k = o.value.trim().toLowerCase();
      if (seen.has(k)) {
        // keep the richer entry (hint / coordinates) when the same place comes from two sources
        const prev = out.find((x) => x.value.trim().toLowerCase() === k);
        if (prev) Object.assign(prev, { hint: prev.hint ?? o.hint, art: prev.art ?? o.art, lat: prev.lat ?? o.lat, lng: prev.lng ?? o.lng });
        continue;
      }
      seen.add(k);
      out.push({ ...o });
    }
    return out.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(remote), q, lang]);
  const choose = (o: PlaceOption) => {
    onChange(o.label);
    onPick?.(o.value, o);
    p.setOpen(false);
    setActive(-1);
  };
  const showList = (inline || p.open) && options.length > 0;
  const list = (
    <>
      {!q && <div className="group-label listbox-group" style={{ padding: '6px 12px', fontWeight: 700 }}>{L('인기 여행지', 'Popular destinations')}</div>}
      <ul className="listbox" role="listbox" id={`${id}-lb`} tabIndex={-1} aria-label={L('여행지 제안', 'Destination suggestions')} style={inline ? { maxHeight: 'none' } : undefined}>
        {options.map((o, i) => (
          <li key={o.value + i} id={`${id}-o${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}>
            <span className="ico" aria-hidden="true" style={o.art ? { padding: 0, overflow: 'hidden' } : undefined}>
              {o.art ? <img src={`/art/postcards/${o.art}.svg`} alt="" width={40} height={40} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name={o.icon ?? 'pin'} size={18} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <strong className="small">{o.label}</strong>
              {o.hint && <div className="xs muted">{o.hint}</div>}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <div className="popover-anchor" ref={p.ref}>
      <label className="search-slot" htmlFor={`${id}-in`} style={{ cursor: 'text' }}>
        <span className="k">{label ?? L('여행지', 'Where')}</span>
        <input
          id={`${id}-in`}
          enterKeyHint="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-lb`}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${id}-o${active}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
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
            } else if (e.key === 'Enter' && showList && active >= 0) {
              e.preventDefault();
              choose(options[active]);
            } else if (e.key === 'Escape' && p.open) {
              e.preventDefault();
              p.setOpen(false);
              setActive(-1);
            } else if (e.key === 'Tab') {
              p.setOpen(false);
            }
          }}
        />
      </label>
      {showList &&
        (inline ? (
          <div className="dest-inline">{list}</div>
        ) : (
          <div className="popover" ref={popRef} style={{ width: 'min(400px, calc(100vw - 32px))', padding: 8 }}>
            {list}
          </div>
        ))}
    </div>
  );
}
