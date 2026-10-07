'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, f, item, num, str } from '@/lib/shape';
import { formatMoney, formatMoneyCompact } from '@/lib/format';
import { StateView } from '@/components/states';
import { BarChart, Donut, PageHeader, Section, StatCard, StatusPill, DateText } from '@/components/ui';

const sumStatus = (o: any, keys: string[]) => keys.reduce((s, k) => s + (Number(o?.[k]) || 0), 0);
const sumAll = (o: any) => Object.values(o ?? {}).reduce((s: number, v) => s + (Number(v) || 0), 0);

export default function AdminOverviewView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/admin/overview', { auth: true });
  return (
    <>
      <PageHeader title={L('운영 개요', 'Operations overview')} subtitle={L('거래액, 사고, 처리 대기열, 준수 적체를 한눈에 봅니다.', 'GMV, incidents, queues and compliance backlog at a glance.')} />
      <StateView state={st} skeleton="table">
        {(d) => {
          const o = item(d) ?? {};
          const g = arr<any>(o, 'gmv').find((x) => str(x, 'currency') === 'KRW') ?? arr<any>(o, 'gmv')[0] ?? {};
          const cur = str(g, 'currency') || 'KRW';
          const gmv = num(g, 'gmvMinor') ?? 0;
          const gross = num(g, 'grossMinor') ?? 0;
          const refunded = num(g, 'refundedMinor') ?? 0;
          const b = f<any>(o, 'bookings') ?? {};
          const res = f<any>(b, 'reservations') ?? {};
          const exc = f<any>(b, 'exchanges') ?? {};
          const gbk = f<any>(b, 'guideBookings') ?? {};
          const ord = f<any>(b, 'orders') ?? {};
          const confirmedRes = sumStatus(res, ['CONFIRMED', 'CHECKED_IN', 'COMPLETED']);
          const confirmedEx = sumStatus(exc, ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED']);
          const resBars = Object.entries(res).map(([k, v]) => ({ label: k.replace(/_/g, ' ').slice(0, 10), value: Number(v) || 0 }));
          const mix = [
            { label: L('숙소 예약', 'Reservations'), value: sumAll(res), color: 'var(--navy-500)' },
            { label: L('홈 맞교환', 'Exchanges'), value: sumAll(exc), color: 'var(--violet-600)' },
            { label: L('가이드', 'Guide bookings'), value: sumAll(gbk), color: 'var(--coral-500)' },
            { label: L('여행 주문', 'Orders'), value: sumAll(ord), color: 'var(--sand-500)' },
          ];
          const cb = f<any>(o, 'complianceBacklog') ?? {};
          const ob = f<any>(o, 'outbox') ?? {};
          const wh = f<any>(o, 'webhooks') ?? {};
          const incidents: Array<[string, number, string]> = [
            [L('웹훅 실패', 'Webhook failures'), num(wh, 'failed') ?? 0, 'FAILED'],
            [L('웹훅 서명 오류', 'Invalid webhook signatures'), num(wh, 'invalidSignature') ?? 0, 'BLOCKED'],
            [L('처리 지연 웹훅', 'Stuck webhooks'), num(wh, 'stuck') ?? 0, 'PENDING'],
            [L('아웃박스 데드레터', 'Outbox dead letters'), num(ob, 'deadLetters') ?? 0, 'FAILED'],
          ].filter(([, n]) => (n as number) > 0) as Array<[string, number, string]>;
          return (
            <>
              <div className="stats">
                <StatCard label={L('거래액 (GMV)', 'GMV')} value={formatMoneyCompact(gmv, cur, lang)} hint={`${L('총 결제', 'Gross')} ${formatMoneyCompact(gross, cur, lang)}`} />
                <StatCard label={L('확정 숙소 예약', 'Confirmed stays')} value={confirmedRes} hint={`${L('전체', 'All')} ${sumAll(res)}`} />
                <StatCard label={L('확정 맞교환', 'Confirmed exchanges')} value={confirmedEx} hint={`${L('전체', 'All')} ${sumAll(exc)}`} />
                <StatCard label={L('환불률', 'Refund rate')} value={gross > 0 ? `${((refunded / gross) * 100).toFixed(1)}%` : '—'} hint={formatMoney(refunded, cur, lang)} />
              </div>
              <div className="grid-2">
                <Section title={L('숙소 예약 상태 분포', 'Reservations by status')}>
                  <div className="card">{resBars.length ? <BarChart data={resBars} label={L('숙소 예약 상태 분포', 'Reservations by status')} /> : <p className="muted">{L('데이터 없음', 'No data')}</p>}</div>
                </Section>
                <Section title={L('도메인별 거래 건수', 'Transactions by domain')}>
                  <div className="card row nowrap" style={{ gap: 20 }}>
                    <Donut parts={mix} label={L('도메인별 거래 건수', 'Transactions by domain')} />
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack small">
                      {mix.map((m) => <li key={m.label}><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: m.color, marginRight: 6 }} />{m.label} · {m.value}</li>)}
                    </ul>
                  </div>
                </Section>
              </div>
              <Section title={L('처리 대기열', 'Work queues')}>
                <div className="stats">
                  {([
                    ['/admin/compliance', L('인허가 심사 대기', 'Permits pending'), num(cb, 'permitsPending') ?? 0],
                    ['/admin/compliance', L('심사 중 숙소', 'Listings in review'), num(cb, 'listingsInReview') ?? 0],
                    ['/admin/compliance', L('가이드 자격 심사', 'Guide qualifications'), num(cb, 'guideQualificationsPending') ?? 0],
                    ['/admin/verifications', L('인증 심사 대기', 'Verifications pending'), num(o, 'verificationBacklog.pending') ?? 0],
                    ['/admin/disputes', L('진행 중 분쟁', 'Open disputes'), num(o, 'disputes.open') ?? 0],
                    ['/admin/ops', L('아웃박스 대기', 'Outbox pending'), num(ob, 'pending') ?? 0],
                  ] as Array<[string, string, number]>).map(([href, label, n]) => (
                    <Link key={label} href={href} className="stat card link" style={{ textDecoration: 'none' }}>
                      <span className="lbl">{label}</span>
                      <span className="val" style={{ color: n > 0 ? 'var(--accent)' : undefined }}>{n}</span>
                      <span className="xs muted">{L('처리하러 가기', 'Open queue')} →</span>
                    </Link>
                  ))}
                </div>
                {str(o, 'verificationBacklog.oldestSubmittedAt') && <p className="small muted">{L('가장 오래된 인증 신청', 'Oldest verification')}: <DateText value={str(o, 'verificationBacklog.oldestSubmittedAt')} time /></p>}
              </Section>
              <Section title={L('사고 · 알림', 'Incidents')}>
                {incidents.length === 0 ? (
                  <p className="muted">✅ {L('진행 중인 사고가 없습니다.', 'No active incidents.')} {str(o, 'generatedAt') && <span className="xs">(<DateText value={str(o, 'generatedAt')} time />)</span>}</p>
                ) : (
                  <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                    {incidents.map(([t, n, s]) => (
                      <li key={t} className="card flat row between"><span><strong>{t}</strong> <span className="small muted">{n}</span></span><StatusPill status={s} live /></li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          );
        }}
      </StateView>
    </>
  );
}
