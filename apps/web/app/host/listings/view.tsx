'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, items, str } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { postcardFor } from '@/lib/art';
import { formatMoney } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { ComplianceBadge } from '@/components/cards';
import { ErrorText, Modal, PageHeader, StatusPill, Button, Icon } from '@/components/ui';

export default function HostListingsView() {
  const { L, lang } = useI18n();
  const router = useRouter();
  const st = useApi<any>('/v1/host/properties', { auth: true });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('APARTMENT');
  const [city, setCity] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L('숙소 관리', 'Listings')} actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>{L('새 숙소', 'New listing')}</Button>} />
      <StateView state={st} skeleton="list" isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="trips" title={L('첫 숙소를 등록해 보세요', 'List your first place')} action={<Button variant="primary" onClick={() => setOpen(true)}>{L('숙소 등록', 'Create listing')}</Button>} />}>
        {(d) => (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {items(d).map((p: any) => {
              const v = propertyView(p);
              return (
                <li key={v.id} className="card row nowrap" style={{ alignItems: 'stretch', gap: 16 }}>
                  <Photo src={v.cover || postcardFor(v.city || v.title, v.id)} seed={v.id} alt="" sizes="120px" style={{ width: 120, height: 90, borderRadius: 'var(--r-md)', flex: '0 0 auto' }} />
                  <div className="grow stack" style={{ gap: 6 }}>
                    <div className="row between">
                      <strong>{v.title}</strong>
                      <StatusPill status={v.status || 'DRAFT'} />
                    </div>
                    <div className="row small muted" style={{ gap: 8 }}>
                      <span>{v.city || '—'}</span>
                      {v.priceMinor !== undefined && <span>{formatMoney(v.priceMinor, v.currency, lang)} / {L('박', 'night')}</span>}
                      <ComplianceBadge status={v.compliance || 'PENDING'} />
                      {v.exchangeEnabled && <span className="badge exchange">⇄ {L('맞교환', 'Exchange')}</span>}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <Link className="btn sm" href={`/host/listings/${v.id}`}><Icon name="settings" size={14} /> {L('편집', 'Edit')}</Link>
                      <Link className="btn sm" href={`/host/listings/${v.id}/media`}>📷 {L('사진', 'Photos')}</Link>
                      <Link className="btn sm" href={`/host/listings/${v.id}/compliance`}>🛡 {L('인허가', 'Compliance')}</Link>
                      <Link className="btn sm ghost" href={`/host/calendar?propertyId=${v.id}`}><Icon name="calendar" size={14} /> {L('달력', 'Calendar')}</Link>
                      {v.status.toUpperCase() === 'PUBLISHED' && <Link className="btn sm ghost" href={`/stay/${v.slug}`}>{L('미리보기', 'View')} ↗</Link>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </StateView>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={L('새 숙소 만들기', 'Create a listing')}
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>{L('취소', 'Cancel')}</button>
            <button
              className="btn primary"
              disabled={!title || busy}
              data-loading={busy ? 'true' : undefined}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const r = await post('/v1/properties', { title, propertyType: type, city, status: 'DRAFT' }, { idempotencyKey: true });
                  router.push(`/host/listings/${str(item(r), 'id')}`);
                } catch (e) {
                  setErr(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {L('초안 만들기', 'Create draft')}
            </button>
          </>
        }
      >
        <div className="stack">
          <label className="field"><span>{L('숙소 이름', 'Title')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L('애월 바다 앞 돌담집', 'Stone cottage by the sea')} autoFocus /></label>
          <label className="field"><span>{L('유형', 'Type')}</span><select value={type} onChange={(e) => setType(e.target.value)}>{['APARTMENT', 'HOUSE', 'HANOK', 'VILLA', 'STUDIO', 'GUESTHOUSE'].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="field"><span>{L('도시', 'City')}</span><input value={city} onChange={(e) => setCity(e.target.value)} /></label>
          <ErrorText error={err} />
        </div>
      </Modal>
    </RequireAuth>
  );
}
