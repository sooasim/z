'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { arr, item, items, str, num } from '@/lib/shape';
import { formatMoney, formatTimeRange } from '@/lib/format';
import { productView } from '@/lib/domain';
import { placeLabel } from '@/lib/places';
import { StateView, EmptyState } from '@/components/states';
import { Alert, Button, ButtonLink, ErrorText, PageHeader, Timeline } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';

export default function ProductItineraryView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/travel-products/${id}`);
  const deps = useApi<any>(`/v1/travel-products/${id}/departures`, { query: { limit: 3 } });
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <StateView state={st} skeleton="detail" back={{ href: '/travel', label: L('여행 상품 목록', 'All tours') }}>
      {(d) => {
        const p = item(d);
        const v = productView(p);
        const days = arr<any>(p, 'itinerary', 'days', 'schedule');
        const next = items(deps.data).slice(0, 3);
        const add = async () => {
          setErr(null);
          setBusy(true);
          try {
            await post('/v1/itineraries', { title: v.title, items: [{ productId: id }] });
            setOk(true);
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        };
        return (
          <>
            <Breadcrumbs items={[{ href: '/travel', label: L('투어·티켓', 'Tours & tickets') }, { href: `/travel/${id}`, label: v.title }, { label: L('일정표', 'Itinerary') }]} />
            <PageHeader
              title={L(`${v.title} 일정표`, `${v.title} · Itinerary`)}
              subtitle={[placeLabel(v.city, lang), v.supplier && L(`${v.supplier} 제공`, `by ${v.supplier}`)].filter(Boolean).join(' · ')}
              actions={
                user ? (
                  <Button variant="primary" icon="plus" loading={busy} onClick={add} disabled={ok}>
                    {ok ? L('플래너에 담았어요', 'Added') : L('내 여행 플래너에 담기', 'Add to my planner')}
                  </Button>
                ) : (
                  <ButtonLink href={`/login?next=${encodeURIComponent(`/travel/${id}/itinerary`)}`}>{L('로그인하고 플래너에 담기', 'Log in to save')}</ButtonLink>
                )
              }
            />
            {ok && (
              <Alert tone="ok">
                {L('플래너에 담았어요.', 'Added to your planner.')} <Link href="/trip-planner">{L('플래너 열기', 'Open planner')}</Link>
              </Alert>
            )}
            <ErrorText error={err} />
            {days.length === 0 ? (
              <EmptyState illo="calendar" title={L('상세 일정은 준비 중이에요', 'The detailed itinerary is coming soon')} action={<ButtonLink href={`/travel/${id}`} variant="primary" icon="left">{L('상품 정보로 돌아가기', 'Back to the product')}</ButtonLink>}>
                <div className="stack" style={{ maxWidth: 460, margin: '0 auto' }}>
                  <p className="muted" style={{ margin: 0 }}>{L('공급사가 시간대별 일정을 아직 올리지 않았어요. 출발일·소요 시간·포함 사항은 상품 정보에서 확인할 수 있어요.', 'The supplier has not published an hour-by-hour plan yet. Departures, duration and inclusions are on the product page.')}</p>
                  {next.length > 0 && (
                    <div className="card flat" style={{ textAlign: 'left' }}>
                      <strong className="small">{L('가까운 출발일', 'Upcoming departures')}</strong>
                      <ul className="stack small" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                        {next.map((x: any) => (
                          <li key={str(x, 'id')} className="row between">
                            <span>{formatTimeRange(str(x, 'startsAt'), str(x, 'endsAt') || null, lang)}</span>
                            <span className="tnum" style={{ fontWeight: 700 }}>{formatMoney(num(x, 'priceMinor') ?? v.priceMinor, v.currency, lang)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </EmptyState>
            ) : (
              <div className="card">
                <Timeline events={days.map((x: any, i: number) => ({ title: `${L(`${num(x, 'day', 'dayNumber') ?? i + 1}일차`, `Day ${num(x, 'day', 'dayNumber') ?? i + 1}`)} · ${str(x, 'title', 'name')}`, note: str(x, 'description', 'summary') }))} />
              </div>
            )}
          </>
        );
      }}
    </StateView>
  );
}
