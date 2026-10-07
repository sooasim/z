'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { arr, item, str, num } from '@/lib/shape';
import { StateView } from '@/components/states';
import { Alert, ErrorText, PageHeader, Timeline } from '@/components/ui';
import Link from 'next/link';

export default function ProductItineraryView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/travel-products/${id}`);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <StateView state={st} skeleton="detail">
      {(d) => {
        const p = item(d);
        const days = arr<any>(p, 'itinerary', 'days', 'schedule');
        return (
          <>
            <PageHeader title={`${str(p, 'title', 'name')} · ${L('일정표', 'Itinerary')}`} back={`/travel/${id}`} actions={user && <button className="btn primary" onClick={async () => { setErr(null); try { await post('/v1/itineraries', { title: str(p, 'title'), items: [{ productId: id }] }); setOk(true); } catch (e) { setErr(e); } }}>{L('내 여행 플래너에 담기', 'Add to my planner')}</button>} />
            {ok && <Alert tone="ok">{L('플래너에 담았어요.', 'Added to planner.')} <Link href="/trip-planner">{L('플래너 열기', 'Open planner')}</Link></Alert>}
            <ErrorText error={err} />
            {days.length === 0 ? (
              <Alert>{L('공급사가 아직 상세 일정을 등록하지 않았습니다.', 'The supplier has not published a detailed itinerary yet.')}</Alert>
            ) : (
              <div className="card">
                <Timeline events={days.map((x: any, i: number) => ({ title: `${L('Day', 'Day')} ${num(x, 'day', 'dayNumber') ?? i + 1} · ${str(x, 'title', 'name')}`, note: str(x, 'description', 'summary') }))} />
              </div>
            )}
          </>
        );
      }}
    </StateView>
  );
}
