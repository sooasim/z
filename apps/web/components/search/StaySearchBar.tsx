'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { DateRangeField, DestinationInput, GuestsField, type Guests } from '@/components/ui/pickers';
import { Icon } from '@/components/ui/icons';

export type SearchMode = 'stay' | 'exchange' | 'guide' | 'tours';

/**
 * Unified search: mode tabs (Stay / Exchange / Guide / Tours), destination autocomplete, date range, guests.
 * `compact` renders the sticky header variant used on /stay.
 */
export function StaySearchBar({ initial, modes = true, compact, defaultMode = 'stay' }: { initial?: { q?: string; checkIn?: string; checkOut?: string; guests?: string }; modes?: boolean; compact?: boolean; defaultMode?: SearchMode }) {
  const { L } = useI18n();
  const router = useRouter();
  const [mode, setMode] = useState<SearchMode>(defaultMode);
  const [q, setQ] = useState(initial?.q ?? '');
  const [range, setRange] = useState({ start: initial?.checkIn ?? '', end: initial?.checkOut ?? '' });
  const [guests, setGuests] = useState<Guests>({ adults: Math.max(1, Number(initial?.guests ?? 2) || 2), children: 0, infants: 0, pets: 0 });

  const submit = () => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    const total = guests.adults + guests.children;
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

  const tabs: Array<[SearchMode, string, string]> = [
    ['stay', L('숙소', 'Stays'), '🏠'],
    ['exchange', L('홈 맞교환', 'Exchange'), '⇄'],
    ['guide', L('가이드', 'Guides'), '🧭'],
    ['tours', L('투어·티켓', 'Tours'), '🎫'],
  ];
  const dateLabels: [string, string] =
    mode === 'stay' ? [L('체크인', 'Check in'), L('체크아웃', 'Check out')] : mode === 'exchange' ? [L('출발', 'From'), L('귀국', 'Until')] : [L('날짜', 'Date'), L('종료', 'End')];

  return (
    <div className="search-card">
      {modes && (
        <div className="seg" role="tablist" aria-label={L('검색 유형', 'Search type')}>
          {tabs.map(([m, label, ico]) => (
            <button key={m} role="tab" type="button" aria-selected={mode === m} onClick={() => setMode(m)}>
              <span aria-hidden="true">{ico}</span> {label}
            </button>
          ))}
        </div>
      )}
      <form
        className="search-bar"
        role="search"
        aria-label={L('여행 검색', 'Search trips')}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DestinationInput value={q} onChange={setQ} />
        <DateRangeField start={range.start} end={range.end} onChange={setRange} labels={dateLabels} />
        <GuestsField value={guests} onChange={setGuests} compact={compact} />
        <button className="btn accent search-go" type="submit" aria-label={L('검색', 'Search')}>
          <Icon name="search" size={20} /> <span>{L('검색', 'Search')}</span>
        </button>
      </form>
    </div>
  );
}
