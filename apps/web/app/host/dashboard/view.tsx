'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { item, items, str, num, f } from '@/lib/shape';
import { formatMoney, formatMoneyCompact, formatRange, parseDateRange } from '@/lib/format';
import { propertyView } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Alert, PageHeader, Section, StatCard, StatusPill, Avatar, ButtonLink, BarChart } from '@/components/ui';

export default function HostDashboardView() {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const res = useApi<any>('/v1/host/reservations', { auth: true, query: { filter: 'upcoming', limit: 50 } });
  const props = useApi<any>('/v1/host/properties', { auth: true });
  const sett = useApi<any>('/v1/provider/settlements', { auth: true, query: { limit: 12 } });
  const rows = items(res.data);
  const listings = items(props.data);
  const settlements = items(sett.data);
  const upcoming = rows.filter((r: any) => ['CONFIRMED', 'PAYMENT_PENDING', 'CHECKED_IN'].includes(str(r, 'status').toUpperCase()));
  const drafts = listings.filter((p: any) => ['DRAFT', 'IN_REVIEW'].includes(propertyView(p).status.toUpperCase()));
  const blocked = listings.filter((p: any) => { const c = propertyView(p).compliance.toUpperCase(); return c && !['PASS', 'PASSED', 'APPROVED', 'COMPLIANT', 'ELIGIBLE', 'OK'].includes(c); });
  const payoutSeries = settlements.slice(0, 6).reverse().map((s: any) => ({ label: str(s, 'periodEnd', 'period', 'createdAt').slice(5, 7) || '—', value: num(s, 'netMinor', 'payoutMinor', 'amountMinor') ?? 0 }));
  const summary = item(sett.data);
  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L(`안녕하세요, ${user?.displayName ?? ''}님`, `Welcome back, ${user?.displayName ?? ''}`)} subtitle={L('오늘의 체크인, 할 일, 정산 현황을 확인하세요.', 'Today’s arrivals, tasks and payouts.')} actions={<ButtonLink href="/host/listings" variant="primary" icon="plus">{L('숙소 등록', 'New listing')}</ButtonLink>} />
      <div className="stats">
        <StatCard label={L('예정된 예약', 'Upcoming stays')} value={res.loading ? '—' : upcoming.length} hint={L('확정 + 결제대기', 'Confirmed + pending')} />
        <StatCard label={L('운영 중인 숙소', 'Live listings')} value={props.loading ? '—' : listings.filter((p: any) => propertyView(p).status.toUpperCase() === 'PUBLISHED').length} hint={`${L('전체', 'Total')} ${listings.length}`} />
        <StatCard label={L('최근 정산액', 'Latest payout')} value={settlements[0] ? formatMoneyCompact(num(settlements[0], 'netMinor', 'payoutMinor', 'amountMinor'), str(settlements[0], 'currency') || 'KRW', lang) : '—'} trend={payoutSeries.map((p) => p.value)} />
        <StatCard label={L('평균 평점', 'Avg rating')} value={num(summary, 'rating', 'avgRating') ?? '—'} hint={L('완료된 숙박 기준', 'From completed stays')} />
      </div>
      {(drafts.length > 0 || blocked.length > 0) && (
        <Section title={L('할 일', 'To-dos')}>
          <div className="stack">
            {blocked.map((p: any) => { const v = propertyView(p); return <Alert key={v.id} tone="warn">{L(`“${v.title}” 인허가 확인이 필요합니다. 확인 전에는 유료 예약이 열리지 않아요.`, `“${v.title}” needs compliance checks before paid booking opens.`)} <Link href={`/host/listings/${v.id}/compliance`}>{L('확인하기', 'Resolve')}</Link></Alert>; })}
            {drafts.map((p: any) => { const v = propertyView(p); return <Alert key={v.id}>{L(`“${v.title}” 작성을 마무리하고 게시하세요.`, `Finish and publish “${v.title}”.`)} <Link href={`/host/listings/${v.id}`}>{L('이어서 작성', 'Continue')}</Link></Alert>; })}
          </div>
        </Section>
      )}
      <div className="grid-2">
        <Section title={L('다가오는 체크인', 'Upcoming arrivals')}>
          <StateView state={res} isEmpty={() => upcoming.length === 0} empty={<EmptyState illo="calendar" title={L('예정된 예약이 없어요', 'No upcoming stays')} />}>
            {() => (
              <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                {upcoming.slice(0, 6).map((r: any) => {
                  const dr = parseDateRange(f(r, 'during', 'stayRange')) ?? { start: str(r, 'checkIn', 'startDate'), end: str(r, 'checkOut', 'endDate') };
                  const guest = str(r, 'guestName', 'guest.displayName') || L('게스트', 'Guest');
                  return (
                    <li key={str(r, 'id')} className="card flat row nowrap">
                      <Avatar name={guest} size={44} />
                      <div className="grow">
                        <strong>{guest}</strong>
                        <div className="small muted">{str(r, 'propertyTitle', 'property.title')} · {dr.start && dr.end ? formatRange(dr.start, dr.end, lang) : ''}</div>
                      </div>
                      <StatusPill status={str(r, 'status')} />
                    </li>
                  );
                })}
              </ul>
            )}
          </StateView>
        </Section>
        <Section title={L('월별 정산', 'Monthly payouts')}>
          <div className="card">
            {payoutSeries.length ? <BarChart data={payoutSeries} label={L('월별 정산액', 'Monthly payouts')} format={(n) => formatMoney(n, 'KRW', lang)} /> : <p className="muted">{L('아직 정산 내역이 없습니다.', 'No payouts yet.')}</p>}
            <Link href="/earnings" className="small">{L('정산 상세 보기', 'View statements')} →</Link>
          </div>
        </Section>
      </div>
    </RequireAuth>
  );
}
