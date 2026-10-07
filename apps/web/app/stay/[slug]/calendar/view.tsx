'use client';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { f, item, items, str } from '@/lib/shape';
import { addDays, isoDate } from '@/lib/format';
import { StateView } from '@/components/states';
import { MonthCalendar, calendarDays } from '@/components/calendar';
import { PageHeader } from '@/components/ui';

export default function StayCalendarView() {
  const { slug } = useParams<{ slug: string }>();
  const { L } = useI18n();
  const prop = useApi<any>(`/v1/properties/by-slug/${encodeURIComponent(slug)}`);
  const id = str(item(prop.data), 'id');
  const today = isoDate(new Date());
  const cal = useApi<any>(id ? `/v1/properties/${id}/calendar` : null, { query: { from: today, to: addDays(today, 365) } });
  return (
    <>
      <PageHeader title={L('예약 가능 일정', 'Availability')} subtitle={str(item(prop.data), 'title')} back={`/stay/${slug}`} />
      <StateView state={prop.error ? prop : cal}>
        {(d) => {
          const rows = items(d).length ? items(d) : (f<any[]>(item(d), 'days', 'blocks') ?? []);
          return (
            <>
              <MonthCalendar days={calendarDays(rows)} months={2} legend={false} />
              <p className="small muted">{L('빗금 표시된 날짜는 예약할 수 없습니다. 실시간 재고는 결제 전 서버에서 다시 확인합니다.', 'Hatched dates are unavailable. Availability is re-checked server-side before payment.')}</p>
            </>
          );
        }}
      </StateView>
    </>
  );
}
