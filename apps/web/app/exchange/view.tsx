'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, items, str, num } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { addDays, isoDate, validRange } from '@/lib/format';
import { PropertyCard } from '@/components/cards';
import { StateView, EmptyState, LoginLink } from '@/components/states';
import { Alert, ErrorText, PageHeader, Section } from '@/components/ui';

function ProposeForm({ homeId }: { homeId: string }) {
  const { L } = useI18n();
  const router = useRouter();
  const target = useApi<any>(`/v1/properties/${homeId}`);
  const mine = useApi<any>('/v1/host/properties', { auth: true });
  const today = isoDate(new Date());
  const [myHome, setMyHome] = useState('');
  const [aStart, setAStart] = useState('');
  const [aEnd, setAEnd] = useState('');
  const [same, setSame] = useState(true);
  const [bStart, setBStart] = useState('');
  const [bEnd, setBEnd] = useState('');
  const [guests, setGuests] = useState('2');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const t = propertyView(item(target.data));
  const myHomes = items(mine.data).filter((p: any) => propertyView(p).exchangeEnabled && propertyView(p).status.toUpperCase() === 'PUBLISHED');
  return (
    <Section title={L('맞교환 제안하기', 'Propose an exchange')}>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (!validRange(aStart, aEnd) || (!same && !validRange(bStart, bEnd))) {
            setErr(new Error(L('날짜를 확인하세요.', 'Check the dates.')));
            return;
          }
          setBusy(true);
          try {
            const res = await post(
              '/v1/exchanges',
              {
                // datesB = when THEIR home (B) is used by me; datesA = when MY home (A) is used by them.
                myPropertyId: myHome,
                theirPropertyId: homeId,
                datesB: { start: aStart, end: aEnd },
                datesA: same ? { start: aStart, end: aEnd } : { start: bStart, end: bEnd },
                guestsB: Number(guests) || 1,
                guestsA: Number(guests) || 1,
                message: note || null,
              },
              { idempotencyKey: true },
            );
            router.push(`/exchange/${str(item(res), 'id')}`);
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {L('상대 집', 'Their home')}: <strong>{t.title}</strong> {t.city && `· ${t.city}`}
        </p>
        <label className="field">
          <span>{L('내 집 (맞교환용)', 'My home to offer')}</span>
          <select value={myHome} onChange={(e) => setMyHome(e.target.value)} required>
            <option value="">{mine.loading ? L('불러오는 중…', 'Loading…') : L('선택하세요', 'Choose')}</option>
            {myHomes.map((p: any) => {
              const v = propertyView(p);
              return (
                <option key={v.id} value={v.id}>
                  {v.title} {v.city && `(${v.city})`}
                </option>
              );
            })}
          </select>
          {!mine.loading && myHomes.length === 0 && (
            <small className="hint">
              {L('맞교환 가능한 집이 없습니다.', 'No exchange-enabled home.')} <Link href="/exchange/onboarding">{L('맞교환 시작하기', 'Get started')}</Link>
            </small>
          )}
        </label>
        <fieldset className="form-grid cols-2">
          <legend>{L('내가 상대 집에 머무는 기간', 'My stay at their home')}</legend>
          <label className="field"><span>{L('시작', 'From')}</span><input type="date" min={today} value={aStart} onChange={(e) => { setAStart(e.target.value); if (!aEnd) setAEnd(addDays(e.target.value, 30)); }} required /></label>
          <label className="field"><span>{L('종료', 'To')}</span><input type="date" min={aStart || today} value={aEnd} onChange={(e) => setAEnd(e.target.value)} required /></label>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
          <span>{L('동시 맞교환 (같은 기간에 서로의 집에 머묾)', 'Simultaneous exchange (same dates)')}</span>
        </label>
        {!same && (
          <fieldset className="form-grid cols-2">
            <legend>{L('상대가 내 집에 머무는 기간', 'Their stay at my home')}</legend>
            <label className="field"><span>{L('시작', 'From')}</span><input type="date" min={today} value={bStart} onChange={(e) => setBStart(e.target.value)} required /></label>
            <label className="field"><span>{L('종료', 'To')}</span><input type="date" min={bStart || today} value={bEnd} onChange={(e) => setBEnd(e.target.value)} required /></label>
          </fieldset>
        )}
        <label className="field"><span>{L('인원', 'Guests')}</span><input type="number" min={1} max={20} value={guests} onChange={(e) => setGuests(e.target.value)} /></label>
        <label className="field"><span>{L('인사 메시지', 'Message')}</span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></label>
        <button className="btn primary" disabled={busy || !myHome}>{busy ? L('제안 중…', 'Sending…') : L('제안 보내기', 'Send proposal')}</button>
        <ErrorText error={err} />
      </form>
    </Section>
  );
}

export default function ExchangeDiscoverView() {
  const { L } = useI18n();
  const { user } = useAuth();
  const sp = useSearchParams();
  const home = sp.get('home');
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [months, setMonths] = useState(sp.get('months') ?? '1');
  const startDate = from ? `${from}-01` : undefined;
  const endDate = from ? (() => { const d = new Date(`${from}-01T00:00:00`); d.setMonth(d.getMonth() + Number(months || 1)); return d.toISOString().slice(0, 10); })() : undefined;
  const query = { city: q || undefined, start: startDate, end: endDate, limit: 24 };
  const st = useApi<any>('/v1/exchange/homes', { query, auth: true });
  const elig = useApi<any>(user ? '/v1/exchange/eligibility' : null);
  const eligible = item(elig.data)?.eligible === false ? 'INELIGIBLE' : '';
  return (
    <>
      <PageHeader title={L('한달살기 홈 맞교환', 'Month-long home exchange')} subtitle={L('돈을 주고받지 않고, 검증된 회원끼리 서로의 집을 바꿔 살아봅니다.', 'Swap homes with verified members — no rent changes hands.')} actions={<Link className="btn" href="/exchange/onboarding">{L('내 맞교환 설정', 'My exchange setup')}</Link>} />
      <Alert tone="info">
        <strong>{L('안전하게 맞교환하는 방법', 'How we keep exchanges safe')}</strong>
        <ul style={{ margin: '6px 0 0' }}>
          <li>{L('양측 본인 확인과 집 소유/거주 증빙을 확인합니다.', 'Both sides verify identity and right to host.')}</li>
          <li>{L('조건(날짜·인원·규칙)은 버전으로 관리되며, 최종 조건의 해시가 계약서에 기록됩니다.', 'Terms are versioned and the final terms hash is recorded in the agreement.')}</li>
          <li>{L('양측 서명 후 두 집의 일정이 동시에 잠기며, 한쪽이라도 실패하면 모두 취소됩니다.', 'Both calendars lock atomically after both sign — or neither does.')}</li>
        </ul>
      </Alert>
      {user && eligible === 'INELIGIBLE' && (
        <Alert tone="warn">
          {L('맞교환 자격 확인이 필요합니다.', 'Exchange eligibility required.')} <Link href="/exchange/onboarding">{L('자격 확인하기', 'Check eligibility')}</Link>
        </Alert>
      )}
      {home && (user ? <ProposeForm homeId={home} /> : <div className="state" style={{ marginTop: 16 }}><p>{L('제안하려면 로그인하세요.', 'Log in to propose.')}</p><LoginLink /></div>)}
      <form className="search-bar" style={{ marginTop: 16 }} role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="field"><span>{L('도시/지역', 'City')}</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('제주, 리스본…', 'Jeju, Lisbon…')} /></label>
        <label className="field"><span>{L('출발 희망 월', 'From')}</span><input type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>{L('기간(개월)', 'Months')}</span><select value={months} onChange={(e) => setMonths(e.target.value)}>{['1', '2', '3'].map((m) => <option key={m}>{m}</option>)}</select></label>
        <span />
        <span />
      </form>
      <div style={{ marginTop: 16 }}>
        <StateView state={st} skeleton="cards" isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="search" title={L('조건에 맞는 맞교환 집이 없습니다.', 'No matching homes.')} />}>
          {(d) => (
            <div className="grid">
              {items(d).map((p: any, i) => (
                <div key={p.id ?? i} className="stack">
                  <PropertyCard p={p} href={`/stay/${encodeURIComponent(propertyView(p).slug)}`} />
                  {num(p, 'mutualFitScore', 'fitScore', 'matchScore') !== undefined && <span className="badge info">{L('상호 적합도', 'Mutual fit')} {Math.round((num(p, 'mutualFitScore', 'fitScore', 'matchScore') ?? 0) * (num(p, 'mutualFitScore', 'fitScore', 'matchScore')! <= 1 ? 100 : 1))}%</span>}
                  <Link className="btn sm" href={`/exchange?home=${str(p, 'id')}`} scroll>
                    🔁 {L('이 집과 맞교환 제안', 'Propose exchange')}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </StateView>
      </div>
    </>
  );
}
