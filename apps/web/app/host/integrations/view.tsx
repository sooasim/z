'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post, api } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { Alert, ErrorText, PageHeader, Section, Button } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/errors';

export default function HostIntegrationsView() {
  const { L } = useI18n();
  const toast = useToast();
  const props = useApi<any>('/v1/host/properties', { auth: true });
  const [pid, setPid] = useState('');
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState('ICAL');
  const [err, setErr] = useState<unknown>(null);
  const [k, setK] = useState(0);
  const list = items(props.data);
  const propertyId = pid || str(list[0], 'id');
  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L('외부 연동', 'Integrations')} subtitle={L('다른 채널의 예약 달력을 iCal로 가져오거나 PMS와 연결하세요. 외부 달력은 JETPOOL 재고에 차단으로 반영됩니다.', 'Import other channels via iCal or connect a PMS. External bookings become blocks in JETPOOL inventory.')} />
      {err instanceof ApiError && err.kind === 'disabled' && <Alert tone="info">{L('PMS 연동은 아직 베타 준비 중입니다. iCal 연동은 사용할 수 있어요.', 'PMS integration is not yet available; iCal works.')}</Alert>}
      <Section title={L('새 연결', 'New connection')}>
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await post('/v1/integrations/accounts', { propertyId, provider, icalUrl: provider === 'ICAL' ? url : undefined });
              toast.show(L('연결했어요. 몇 분 내 동기화됩니다.', 'Connected. Syncing shortly.'));
              setUrl('');
              setK(k + 1);
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <div className="form-grid cols-3">
            <label className="field"><span>{L('숙소', 'Listing')}</span><select value={propertyId} onChange={(e) => setPid(e.target.value)}>{list.map((p: any) => { const v = propertyView(p); return <option key={v.id} value={v.id}>{v.title}</option>; })}</select></label>
            <label className="field"><span>{L('방식', 'Type')}</span><select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="ICAL">iCal</option><option value="SMOOBU">Smoobu (PMS)</option><option value="GENERIC_WEBHOOK">{L('일반 웹훅', 'Generic webhook')}</option></select></label>
            <label className="field"><span>{provider === 'ICAL' ? L('iCal 주소', 'iCal URL') : L('PMS 엔드포인트', 'PMS endpoint')}</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required={provider === 'ICAL'} placeholder="https://…/calendar.ics" /></label>
          </div>
          <Button type="submit" variant="primary" style={{ justifySelf: 'start' }}>{L('연결', 'Connect')}</Button>
          <ErrorText error={err} />
        </form>
      </Section>
      <Section title={L('JETPOOL 달력 내보내기 (iCal)', 'Export JETPOOL calendar (iCal)')}>
        <div className="card row between">
          <span className="small muted">{L('다른 채널에 JETPOOL 예약을 차단으로 반영하려면 내보내기 주소를 등록하세요.', 'Register this URL in other channels to block JETPOOL bookings there.')}</span>
          <Button
            onClick={async () => {
              setErr(null);
              try {
                const r: any = await post(`/v1/integrations/properties/${propertyId}/ical-export-token`, {});
                const u = r?.url ?? r?.item?.url ?? r?.exportUrl;
                if (u) {
                  await navigator.clipboard?.writeText(u);
                  toast.show(L('내보내기 주소를 복사했어요', 'Export URL copied'));
                }
              } catch (x) {
                setErr(x);
              }
            }}
          >
            {L('내보내기 주소 발급·복사', 'Get & copy export URL')}
          </Button>
        </div>
      </Section>
      <Section title={L('내 연결', 'Connections')}>
        <ResourceTable
          key={k}
          path="/v1/integrations/accounts"
          columns={[
            { key: 'provider', label: L('방식', 'Type') },
            { key: 'propertyId|property_id', label: L('숙소', 'Listing'), kind: 'id' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
            { key: 'lastSyncAt|lastSyncedAt|last_sync_at', label: L('마지막 동기화', 'Last sync'), kind: 'datetime' },
            { key: 'lastError|last_error', label: L('오류', 'Error') },
          ]}
          actions={[
            { label: L('지금 동기화', 'Sync now'), tone: 'primary', run: (r) => post(`/v1/integrations/accounts/${str(r, 'id')}/sync`, {}) },
            { label: L('일시 중지', 'Pause'), when: (r) => str(r, 'status').toUpperCase() === 'ACTIVE', run: (r) => api(`/v1/integrations/accounts/${str(r, 'id')}`, { method: 'PATCH', body: { status: 'PAUSED' } }) },
            { label: L('재개', 'Resume'), when: (r) => str(r, 'status').toUpperCase() === 'PAUSED', run: (r) => api(`/v1/integrations/accounts/${str(r, 'id')}`, { method: 'PATCH', body: { status: 'ACTIVE' } }) },
          ]}
          empty={<p className="muted">{L('연결된 외부 채널이 없습니다.', 'No connections.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}
