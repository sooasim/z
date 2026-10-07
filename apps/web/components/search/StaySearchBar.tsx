'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { addDays, isoDate, validRange } from '@/lib/format';

export function StaySearchBar({ initial }: { initial?: { q?: string; checkIn?: string; checkOut?: string; guests?: string } }) {
  const { t, L } = useI18n();
  const router = useRouter();
  const today = isoDate(new Date());
  const [q, setQ] = useState(initial?.q ?? '');
  const [checkIn, setIn] = useState(initial?.checkIn ?? '');
  const [checkOut, setOut] = useState(initial?.checkOut ?? '');
  const [guests, setGuests] = useState(initial?.guests ?? '2');
  const [err, setErr] = useState('');
  return (
    <form
      className="search-bar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if ((checkIn || checkOut) && !validRange(checkIn, checkOut)) {
          setErr(L('체크아웃은 체크인 이후여야 합니다.', 'Check-out must be after check-in.'));
          return;
        }
        setErr('');
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        if (checkIn) p.set('checkIn', checkIn);
        if (checkOut) p.set('checkOut', checkOut);
        if (guests) p.set('guests', guests);
        router.push(`/stay?${p}`);
      }}
    >
      <label className="field">
        <span>{L('어디로 가세요?', 'Where to?')}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('제주, 부산, 치앙마이…', 'Jeju, Busan, Chiang Mai…')} />
      </label>
      <label className="field">
        <span>{t('common.checkin')}</span>
        <input type="date" min={today} value={checkIn} onChange={(e) => { setIn(e.target.value); if (!checkOut || checkOut <= e.target.value) setOut(addDays(e.target.value, 1)); }} />
      </label>
      <label className="field">
        <span>{t('common.checkout')}</span>
        <input type="date" min={checkIn ? addDays(checkIn, 1) : today} value={checkOut} onChange={(e) => setOut(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('common.guests')}</span>
        <input type="number" min={1} max={30} value={guests} onChange={(e) => setGuests(e.target.value)} />
      </label>
      <button className="btn primary" type="submit">
        {t('common.search')}
      </button>
      {err && (
        <p role="alert" className="small" style={{ color: 'var(--c-danger)', margin: 0 }}>
          {err}
        </p>
      )}
    </form>
  );
}
