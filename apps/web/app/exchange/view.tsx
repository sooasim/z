'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, items, str, num } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { validRange } from '@/lib/format';
import { canonicalPlace, placeLabel } from '@/lib/places';
import { PropertyCard } from '@/components/cards';
import { StateView, EmptyState } from '@/components/states';
import { Alert, Button, ButtonLink, DateRangeField, DestinationInput, ErrorText, HeadingLevel, Icon, PageHeader, Qty, Section, Select, Skeleton, Textarea } from '@/components/ui';
import { AuthTeaser } from '@/components/public/AuthTeaser';
import { useDebounced, useUrlSync } from '@/components/public/hooks';
import { ELIGIBILITY } from './shared';
import s from '@/components/public/public.module.css';
import { pickText } from '@/lib/phrases';

/** Next 12 months as select options: { value: '2026-11', label: '2026년 11월' }. */
function useMonthOptions() {
  const { lang } = useI18n();
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long' });
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: fmt.format(d) };
    });
  }, [lang]);
}

function EligibilityCard({ unmet }: { unmet: string[] }) {
  const { L, lang } = useI18n();
  const codes = Object.keys(ELIGIBILITY);
  return (
    <div className="card stack">
      <div className="row nowrap" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className={s.icoTile} aria-hidden="true">
          <Icon name="shield" size={20} />
        </span>
        <div>
          <h3 style={{ margin: 0 }}>{L('제안하기 전에 맞교환 설정을 마쳐 주세요', 'Finish your exchange setup to propose')}</h3>
          <p className="small muted" style={{ margin: '4px 0 0' }}>{L('검증된 회원끼리만 맞교환할 수 있어요. 남은 항목을 완료하면 바로 제안할 수 있어요.', 'Exchanges are between verified members only. Complete the remaining items and you can propose right away.')}</p>
        </div>
      </div>
      <ul className={s.check}>
        {codes.map((code) => {
          const ok = !unmet.includes(code);
          const it = ELIGIBILITY[code];
          return (
            <li key={code} className={ok ? s.ok : s.todo} style={{ alignItems: 'center' }}>
              <Icon name={ok ? 'check-circle' : 'circle'} size={20} />
              <span className="grow small">
                {pickText(it, lang)}
                <span className="sr-only">{ok ? L(' (완료)', ' (done)') : L(' (필요)', ' (to do)')}</span>
              </span>
              {!ok && (
                <ButtonLink href={it.href} size="sm">
                  {L('하러 가기', 'Do it')}
                </ButtonLink>
              )}
            </li>
          );
        })}
      </ul>
      <ButtonLink href="/exchange/onboarding" variant="primary" icon="swap">
        {L('맞교환 설정 완료하기', 'Finish exchange setup')}
      </ButtonLink>
    </div>
  );
}

function ProposeForm({ homeId, unmet, eligible }: { homeId: string; unmet: string[]; eligible: boolean | undefined }) {
  const { L, lang } = useI18n();
  const router = useRouter();
  const target = useApi<any>(`/v1/properties/${homeId}`);
  const mine = useApi<any>('/v1/host/properties', { auth: true });
  const [myHome, setMyHome] = useState('');
  const [myStay, setMyStay] = useState({ start: '', end: '' });
  const [same, setSame] = useState(true);
  const [theirStay, setTheirStay] = useState({ start: '', end: '' });
  const [guests, setGuests] = useState(2);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const t = propertyView(item(target.data));
  const myHomes = items(mine.data).filter((p: any) => propertyView(p).exchangeEnabled && propertyView(p).status.toUpperCase() === 'PUBLISHED');
  return (
    <Section title={L('맞교환 제안하기', 'Propose an exchange')} id="propose">
      {target.loading ? (
        <Skeleton h={80} />
      ) : (
        t.id && (
          <div className="card flat row nowrap" style={{ gap: 12, background: 'var(--surface-2)' }}>
            <Icon name="home" size={20} />
            <span className="grow">
              {L('제안할 집', 'Their home')}: <strong>{t.title}</strong> <span className="muted small">{placeLabel(t.city, lang)}</span>
            </span>
          </div>
        )
      )}
      {eligible === undefined ? (
        <Skeleton h={160} />
      ) : !eligible ? (
        <EligibilityCard unmet={unmet} />
      ) : (
        <form
          className="card stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const fe: Record<string, string> = {};
            if (!myHome) fe.myHome = L('맞교환할 내 집을 골라 주세요.', 'Choose your home.');
            if (!validRange(myStay.start, myStay.end)) fe.myStay = L('머무를 기간을 골라 주세요.', 'Choose your dates.');
            if (!same && !validRange(theirStay.start, theirStay.end)) fe.theirStay = L('상대가 머무를 기간을 골라 주세요.', 'Choose their dates.');
            setErrors(fe);
            if (Object.keys(fe).length) return;
            setBusy(true);
            try {
              const res = await post(
                '/v1/exchanges',
                {
                  // datesB = when THEIR home (B) is used by me; datesA = when MY home (A) is used by them.
                  myPropertyId: myHome,
                  theirPropertyId: homeId,
                  datesB: myStay,
                  datesA: same ? myStay : theirStay,
                  guestsB: guests,
                  guestsA: guests,
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
          <label className="field">
            <span>
              {L('내 집 (맞교환용)', 'My home to offer')} <span aria-hidden="true">*</span>
            </span>
            <select value={myHome} onChange={(e) => setMyHome(e.target.value)} aria-invalid={errors.myHome ? true : undefined} aria-describedby={errors.myHome ? 'myhome-e' : undefined}>
              <option value="">{mine.loading ? L('불러오는 중…', 'Loading…') : L('선택하세요', 'Choose')}</option>
              {myHomes.map((p: any) => {
                const v = propertyView(p);
                return (
                  <option key={v.id} value={v.id}>
                    {v.title} {v.city && `(${placeLabel(v.city, lang)})`}
                  </option>
                );
              })}
            </select>
            {errors.myHome && <small className="err" id="myhome-e">{errors.myHome}</small>}
          </label>
          <div className="field">
            <span>
              {L(`내가 ${t.title || '상대 집'}에 머무는 기간`, `My stay at ${t.title || 'their home'}`)} <span aria-hidden="true">*</span>
            </span>
            <DateRangeField start={myStay.start} end={myStay.end} onChange={setMyStay} boxed />
            {errors.myStay && <small className="err">{errors.myStay}</small>}
          </div>
          <label className="check">
            <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
            <span>{L('같은 기간에 서로의 집에 머물러요 (동시 맞교환)', 'We swap at the same time (simultaneous exchange)')}</span>
          </label>
          {!same && (
            <div className="field">
              <span>
                {L('상대가 내 집에 머무는 기간', 'Their stay at my home')} <span aria-hidden="true">*</span>
              </span>
              <DateRangeField start={theirStay.start} end={theirStay.end} onChange={setTheirStay} boxed />
              {errors.theirStay && <small className="err">{errors.theirStay}</small>}
            </div>
          )}
          <div className="guest-row" style={{ borderBottom: 0 }}>
            <strong>{L('함께 가는 인원', 'Guests travelling')}</strong>
            <Qty label={L('인원', 'Guests')} value={guests} min={1} max={20} onChange={setGuests} />
          </div>
          <Textarea label={L('인사 메시지', 'Message')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder={L('우리 가족 소개, 집에서 지내는 방식, 원하는 점을 적어 주세요.', 'Introduce yourselves and how you live at home.')} />
          <Button type="submit" variant="primary" loading={busy} icon="swap">
            {L('제안 보내기', 'Send proposal')}
          </Button>
          <p className="xs muted" style={{ margin: 0 }}>{L('상대가 수락하기 전까지 비용은 들지 않고, 언제든 철회할 수 있어요.', 'No cost until both agree, and you can withdraw any time before signing.')}</p>
          <ErrorText error={err} />
        </form>
      )}
    </Section>
  );
}

export default function ExchangeDiscoverView() {
  const { L, lang } = useI18n();
  const { ready, user } = useAuth();
  const sp = useSearchParams();
  const home = sp.get('home');
  const months12 = useMonthOptions();
  const [area, setArea] = useState(() => placeLabel(sp.get('q') ?? '', lang));
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [months, setMonths] = useState(sp.get('months') ?? '1');
  const typed = useDebounced(area.trim(), 300);
  const city = canonicalPlace(typed);
  useUrlSync({ home: home ?? undefined, q: city, from, months: from ? months : undefined });
  const startDate = from ? `${from}-01` : undefined;
  const endDate = from
    ? (() => {
        const [y, m] = from.split('-').map(Number);
        const d = new Date(y, m - 1 + Number(months || 1), 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      })()
    : undefined;
  const st = useApi<any>(user ? '/v1/exchange/homes' : null, { query: { city: city || undefined, start: startDate, end: endDate, limit: 24 } });
  const elig = useApi<any>(user ? '/v1/exchange/eligibility' : null);
  const eligData = item(elig.data);
  const eligible = eligData ? eligData.eligible !== false : undefined;
  const unmet = arr<string>(eligData, 'unmet');
  return (
    <>
      <PageHeader
        title={L('한달살기 홈 맞교환', 'Month-long home exchange')}
        subtitle={L('돈을 주고받지 않고, 검증된 회원끼리 서로의 집을 바꿔 살아봐요.', 'Swap homes with verified members — no rent changes hands.')}
        actions={user ? <ButtonLink href="/exchange/onboarding" icon="settings">{L('내 맞교환 설정', 'My exchange setup')}</ButtonLink> : undefined}
      />
      {ready && !user ? (
        <AuthTeaser
          title={L('검증된 회원만 집을 볼 수 있어요', 'Homes are visible to verified members only')}
          lead={L('가입하고 본인 인증을 마치면 맞교환할 집을 둘러보고 제안할 수 있어요. 서로의 집과 일상을 지키기 위한 약속이에요.', 'Sign up and verify your identity to browse homes and propose exchanges — it keeps everyone’s home safe.')}
          benefits={[
            { icon: 'verified', title: L('양측 본인 인증', 'Both sides verified'), body: L('신분과 집 등록을 확인한 회원끼리만 연결돼요.', 'Only members with verified identity and homes are matched.') },
            { icon: 'doc', title: L('조건 합의와 전자 계약', 'Agreed terms & e-contract'), body: L('최종 합의 내용은 계약서에 안전하게 기록돼 변경할 수 없어요.', 'Final terms are recorded securely in the agreement and cannot be changed.') },
            { icon: 'swap', title: L('함께 확정되는 일정', 'Both homes confirmed together'), body: L('두 집 일정이 함께 확정돼요 — 한쪽이 취소되면 모두 취소돼요.', 'Both homes are booked together — if one side cancels, both are cancelled.') },
          ]}
          preview={
            <>
              <div className="row nowrap" style={{ gap: 10 }}>
                <Photo src="/art/postcards/busan.svg" alt="" sizes="64px" style={{ width: 64, height: 64, borderRadius: 12, flex: '0 0 auto' }} />
                <span style={{ display: 'grid' }}>
                  <strong className="small">{L('해운대 한달살기 집', 'Haeundae month-stay flat')}</strong>
                  <span className="xs muted">{L('부산 · 11월~12월', 'Busan · Nov–Dec')}</span>
                </span>
              </div>
              <div className="center" aria-hidden="true" style={{ color: 'var(--accent-deco)' }}>
                <Icon name="swap" size={22} style={{ margin: '0 auto' }} />
              </div>
              <div className="row nowrap" style={{ gap: 10 }}>
                <Photo src="/art/postcards/seoul.svg" alt="" sizes="64px" style={{ width: 64, height: 64, borderRadius: 12, flex: '0 0 auto' }} />
                <span style={{ display: 'grid' }}>
                  <strong className="small">{L('북촌 한옥 스테이', 'Bukchon hanok stay')}</strong>
                  <span className="xs muted">{L('서울 · 같은 기간', 'Seoul · same dates')}</span>
                </span>
              </div>
            </>
          }
          note={L('맞교환은 숙박비가 없어요. 플랫폼 이용료와 보험은 확정 단계에서 안내해 드려요.', 'No rent is paid. Any platform fee or insurance is explained before you confirm.')}
        />
      ) : (
        <>
          <div className="stack">
            <Alert tone="info">
              <strong>{L('안전하게 맞교환하는 방법', 'How we keep exchanges safe')}</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>{L('양측 본인 인증과 집 등록 상태를 확인해요.', 'Both sides verify their identity and home.')}</li>
                <li>{L('최종 합의 내용은 계약서에 안전하게 기록돼 변경할 수 없어요.', 'Final terms are recorded securely in the agreement and cannot be changed.')}</li>
                <li>{L('두 집 일정이 함께 확정돼요 — 한쪽이 취소되면 모두 취소돼요.', 'Both homes are booked together — if one side cancels, both are cancelled.')}</li>
              </ul>
            </Alert>
            {user && eligible === false && !home && (
              <Alert tone="warn">
                {L('맞교환을 제안하려면 설정을 마쳐야 해요.', 'Finish your exchange setup to propose.')}{' '}
                <Link href="/exchange/onboarding">{L('남은 항목 보기', 'See what’s left')}</Link>
              </Alert>
            )}
          </div>
          {home && user && <ProposeForm homeId={home} unmet={unmet} eligible={eligible} />}
          <form className="card form-grid cols-3" style={{ marginTop: 'var(--sp-6)' }} role="search" aria-label={L('맞교환 집 찾기', 'Find homes')} onSubmit={(e) => e.preventDefault()}>
            <div className={s.slotField}>
              <span className={s.lbl} aria-hidden="true">{L('도시 · 지역', 'City')}</span>
              <DestinationInput label={L('도시 · 지역', 'City')} value={area} onChange={setArea} placeholder={L('제주, 도쿄, 리스본…', 'Jeju, Tokyo, Lisbon…')} />
            </div>
            <Select label={L('출발 희망 월', 'Starting month')} value={from} onChange={(e) => setFrom(e.target.value)} options={[{ value: '', label: L('언제든', 'Any time') }, ...months12]} />
            <Select label={L('기간', 'Length')} value={months} onChange={(e) => setMonths(e.target.value)} options={['1', '2', '3'].map((m) => ({ value: m, label: L(`${m}개월`, `${m} month${m === '1' ? '' : 's'}`) }))} disabled={!from} />
          </form>
          <div style={{ marginTop: 16 }}>
            <StateView
              state={user ? st : { data: undefined, error: null, loading: true }}
              skeleton="cards"
              isEmpty={(d) => items(d).length === 0}
              empty={
                <EmptyState illo="search" title={city ? L(`${placeLabel(city, 'ko')}에 맞교환 가능한 집이 아직 없어요`, `No exchange homes in ${placeLabel(city, 'en')} yet`) : L('조건에 맞는 맞교환 집이 없어요', 'No matching homes')} action={<Button variant="primary" onClick={() => { setArea(''); setFrom(''); }}>{L('조건 지우기', 'Clear filters')}</Button>}>
                  {L('다른 도시나 달을 골라 보세요. 새 집이 매주 등록되고 있어요.', 'Try another city or month — new homes are added every week.')}
                </EmptyState>
              }
            >
              {(d) => (
                <HeadingLevel level={2}>
                  <div className="grid">
                    {items(d).map((p: any, i) => {
                      const fit = num(p, 'mutualFitScore', 'fitScore', 'matchScore');
                      return (
                        <div key={p.id ?? i} className="stack">
                          <PropertyCard p={p} href={`/stay/${encodeURIComponent(propertyView(p).slug)}`} />
                          {fit !== undefined && (
                            <span className="badge info" style={{ justifySelf: 'start' }}>
                              {L('서로 잘 맞아요', 'Mutual fit')} {Math.round(fit * (fit <= 1 ? 100 : 1))}%
                            </span>
                          )}
                          <ButtonLink href={`/exchange?home=${str(p, 'id')}#propose`} size="sm" icon="swap">
                            {L('이 집과 맞교환 제안', 'Propose exchange')}
                          </ButtonLink>
                        </div>
                      );
                    })}
                  </div>
                </HeadingLevel>
              )}
            </StateView>
          </div>
        </>
      )}
    </>
  );
}
