'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { canonicalPlace, placeLabel } from '@/lib/places';
import { formatRange, nightsBetween } from '@/lib/format';
import { DateRangeField, DestinationInput, GuestsField, GuestsPanel, RangeCalendar, guestTotal, type Guests } from '@/components/ui/pickers';
import { Icon, type IconName } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';

export type SearchMode = 'stay' | 'exchange' | 'guide' | 'tours';

/**
 * Unified search: mode tabs (Stay / Exchange / Guide / Tours), destination autocomplete, date range, guests.
 * `compact` renders the sticky header variant used on /stay.
 *
 * The destination input shows the localized place name ("제주") but searches send the canonical API value
 * (`q=Jeju`, from the picked suggestion or `canonicalPlace()`), so Korean searches match English city names.
 *
 * Below 860px (`pill`, default on) the form collapses into one summary pill ("제주 · 11월 2–6일 · 2명") that opens
 * the full form as a bottom sheet with step-by-step sections — the sticky bar on /stay stays one line tall.
 */
export function StaySearchBar({ initial, modes = true, compact, defaultMode = 'stay', pill = true }: { initial?: { q?: string; checkIn?: string; checkOut?: string; guests?: string }; modes?: boolean; compact?: boolean; defaultMode?: SearchMode; pill?: boolean }) {
  const { L, lang } = useI18n();
  const router = useRouter();
  const [mode, setMode] = useState<SearchMode>(defaultMode);
  const [q, setQ] = useState(() => placeLabel(initial?.q ?? '', lang));
  /** Canonical value of the picked suggestion; cleared as soon as the user edits the text again. */
  const [picked, setPicked] = useState<string>(() => (initial?.q ? canonicalPlace(initial.q) : ''));
  const [range, setRange] = useState({ start: initial?.checkIn ?? '', end: initial?.checkOut ?? '' });
  const [guests, setGuests] = useState<Guests>({ adults: Math.max(1, Number(initial?.guests ?? 2) || 2), children: 0, infants: 0, pets: 0 });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [step, setStep] = useState<'where' | 'when' | 'who'>('where');

  // Re-label a known place when the UI language flips (제주 ⇄ Jeju) unless the user typed free text.
  useEffect(() => {
    setQ((cur) => (picked && canonicalPlace(cur) === picked ? placeLabel(picked, lang) : cur));
  }, [lang, picked]);

  const submit = () => {
    const p = new URLSearchParams();
    const dest = (picked && canonicalPlace(q) === picked ? picked : canonicalPlace(q)).trim();
    if (dest) p.set('q', dest);
    const total = guests.adults + guests.children;
    setSheetOpen(false);
    if (mode === 'stay') {
      if (range.start) p.set('checkIn', range.start);
      if (range.end) p.set('checkOut', range.end);
      p.set('guests', String(total));
      if (guests.pets) p.set('pets', String(guests.pets));
      router.push(`/stay?${p}`);
    } else if (mode === 'exchange') {
      if (range.start) p.set('from', range.start.slice(0, 7));
      router.push(`/exchange?${p}`);
    } else if (mode === 'guide') {
      if (range.start) p.set('date', range.start);
      router.push(`/guide-friends?${p}`);
    } else {
      if (range.start) p.set('date', range.start);
      router.push(`/travel?${p}`);
    }
  };

  const tabs: Array<[SearchMode, string, IconName]> = [
    ['stay', L('숙소', 'Stays'), 'home'],
    ['exchange', L('홈 맞교환', 'Exchange'), 'swap'],
    ['guide', L('가이드', 'Guides'), 'compass'],
    ['tours', L('투어·티켓', 'Tours'), 'ticket'],
  ];
  const dateLabels: [string, string] =
    mode === 'stay' ? [L('체크인', 'Check in'), L('체크아웃', 'Check out')] : mode === 'exchange' ? [L('출발', 'From'), L('귀국', 'Until')] : [L('날짜', 'Date'), L('종료', 'End')];

  const modeTabs = (
    <div className="seg modes" role="tablist" aria-label={L('검색 유형', 'Search type')}>
      {tabs.map(([m, label, ico]) => (
        <button
          key={m}
          role="tab"
          type="button"
          aria-selected={mode === m}
          tabIndex={mode === m ? 0 : -1}
          onClick={() => setMode(m)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((t) => t[0] === mode);
            const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
            if (n < 0) return;
            e.preventDefault();
            setMode(tabs[n][0]);
            (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
          }}
        >
          <Icon name={ico} size={16} /> {label}
        </button>
      ))}
    </div>
  );

  const nights = nightsBetween(range.start, range.end);
  const total = guestTotal(guests);
  const whenText = range.start && range.end ? formatRange(range.start, range.end, lang, { year: false }) : range.start ? formatRange(range.start, range.start, lang, { year: false }).split(' – ')[0] : L('날짜 추가', 'Add dates');
  const whoText = `${L('게스트', 'Guests')} ${total}${L('명', '')}`;

  return (
    <div className={`search-card ${pill ? 'has-pill' : ''}`}>
      {pill && (
        <button
          type="button"
          className="search-pill"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => {
            setStep(q ? (range.start && range.end ? 'who' : 'when') : 'where');
            setSheetOpen(true);
          }}
        >
          <span className="txt">
            <strong>{q.trim() || (compact ? L('모든 지역', 'Anywhere') : L('어디로 떠나시나요?', 'Where to?'))}</strong>
            <span>{[range.start ? whenText : L('날짜 추가', 'Add dates'), whoText].join(' · ')}</span>
          </span>
          <span className="go" aria-hidden="true">
            <Icon name="search" size={18} />
          </span>
        </button>
      )}
      {modes && modeTabs}
      <form
        className="search-bar"
        role="search"
        aria-label={L('여행 검색', 'Search trips')}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DestinationInput
          value={q}
          onChange={(v) => {
            setQ(v);
            if (picked && canonicalPlace(v) !== picked) setPicked('');
          }}
          onPick={(v) => setPicked(v)}
        />
        <DateRangeField start={range.start} end={range.end} onChange={setRange} labels={dateLabels} />
        <GuestsField value={guests} onChange={setGuests} compact={compact} />
        <button className="btn accent search-go" type="submit" aria-label={L('검색', 'Search')}>
          <Icon name="search" size={20} /> <span>{L('검색', 'Search')}</span>
        </button>
      </form>

      {pill && (
        <Modal
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={L('검색', 'Search')}
          className="sheet-search"
          footer={
            <>
              <button
                type="button"
                className="btn link sm"
                onClick={() => {
                  setQ('');
                  setPicked('');
                  setRange({ start: '', end: '' });
                  setGuests({ adults: 2, children: 0, infants: 0, pets: 0 });
                  setStep('where');
                }}
              >
                {L('전체 지우기', 'Clear all')}
              </button>
              <button type="button" className="btn accent" onClick={submit}>
                <Icon name="search" size={18} /> {L('검색', 'Search')}
              </button>
            </>
          }
        >
          <div className="stack">
            {modes && modeTabs}
            <section className={`sheet-step ${step === 'where' ? 'open' : ''}`}>
              {step === 'where' ? (
                <>
                  <h3 className="sheet-step-title">{L('어디로 떠나시나요?', 'Where to?')}</h3>
                  <DestinationInput
                    inline
                    autoFocus
                    value={q}
                    onChange={(v) => {
                      setQ(v);
                      if (picked && canonicalPlace(v) !== picked) setPicked('');
                    }}
                    onPick={(v) => {
                      setPicked(v);
                      setStep('when');
                    }}
                  />
                </>
              ) : (
                <button type="button" className="sheet-step-sum" onClick={() => setStep('where')}>
                  <span>{L('여행지', 'Where')}</span>
                  <strong>{q.trim() || L('어디든', 'Anywhere')}</strong>
                </button>
              )}
            </section>
            <section className={`sheet-step ${step === 'when' ? 'open' : ''}`}>
              {step === 'when' ? (
                <>
                  <h3 className="sheet-step-title">{mode === 'stay' ? L('언제 머무시나요?', 'When is your stay?') : L('언제 떠나시나요?', 'When?')}</h3>
                  <RangeCalendar
                    start={range.start}
                    end={range.end}
                    months={1}
                    onChange={(r) => {
                      setRange(r);
                      if (r.start && r.end) setStep('who');
                    }}
                  />
                </>
              ) : (
                <button type="button" className="sheet-step-sum" onClick={() => setStep('when')}>
                  <span>{L('날짜', 'When')}</span>
                  <strong>{range.start ? `${whenText}${nights ? ` · ${nights}${L('박', ' nights')}` : ''}` : L('날짜 추가', 'Add dates')}</strong>
                </button>
              )}
            </section>
            <section className={`sheet-step ${step === 'who' ? 'open' : ''}`}>
              {step === 'who' ? (
                <>
                  <h3 className="sheet-step-title">{L('누구와 함께하나요?', 'Who’s coming?')}</h3>
                  <GuestsPanel value={guests} onChange={setGuests} />
                </>
              ) : (
                <button type="button" className="sheet-step-sum" onClick={() => setStep('who')}>
                  <span>{L('인원', 'Who')}</span>
                  <strong>{whoText}</strong>
                </button>
              )}
            </section>
          </div>
        </Modal>
      )}
    </div>
  );
}
