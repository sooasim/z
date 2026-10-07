'use client';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { f, item, num, str } from '@/lib/shape';
import { StateView } from '@/components/states';
import { ResourceTable } from '@/components/table';
import { PageHeader, Section, StatCard, StatusPill } from '@/components/ui';

export default function AdminOpsView() {
  const { L } = useI18n();
  const ov = useApi<any>('/v1/admin/overview', { auth: true });
  const ready = useApi<any>('/ready');
  return (
    <>
      <PageHeader title={L('시스템 상태', 'System health')} subtitle={L('아웃박스 지연, 데드레터, 웹훅, 의존성 준비 상태', 'Outbox lag, dead letters, webhooks and dependency readiness')} />
      <StateView state={ov} skeleton="table">
        {(d) => {
          const o = item(d) ?? {};
          const ob = f<any>(o, 'outbox') ?? {};
          const wh = f<any>(o, 'webhooks') ?? {};
          return (
            <div className="stats">
              <StatCard label={L('아웃박스 대기', 'Outbox pending')} value={num(ob, 'pending') ?? 0} hint={`${L('최장 대기', 'Oldest')} ${num(ob, 'oldestPendingAgeSec') ?? 0}s`} />
              <StatCard label={L('데드레터', 'Dead letters')} value={num(ob, 'deadLetters') ?? 0} />
              <StatCard label={L('웹훅 실패', 'Webhook failures')} value={num(wh, 'failed') ?? 0} hint={`${L('서명 오류', 'Bad signature')} ${num(wh, 'invalidSignature') ?? 0}`} />
              <StatCard label={L('처리 지연 웹훅', 'Stuck webhooks')} value={num(wh, 'stuck') ?? 0} />
            </div>
          );
        }}
      </StateView>
      <Section title={L('의존성 준비 상태 (/ready)', 'Readiness (/ready)')}>
        <div className="card">
          {ready.loading ? (
            <p className="muted">…</p>
          ) : ready.error ? (
            <StatusPill status="FAILED" />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {Object.entries((ready.data as any)?.checks ?? (ready.data as any) ?? {}).map(([k, v]) => (
                <li key={k} className="row between"><span className="mono">{k}</span><StatusPill status={typeof v === 'object' ? str(v, 'status') || (f(v, 'ok') ? 'OK' : 'FAIL') : String(v).toUpperCase() === 'TRUE' || String(v).toUpperCase() === 'OK' ? 'OK' : String(v)} /></li>
              ))}
            </ul>
          )}
        </div>
      </Section>
      <Section title={L('아웃박스 데드레터', 'Outbox dead letters')}>
        <ResourceTable
          path="/v1/admin/outbox/dead-letters"
          columns={[
            { key: 'eventType|event_type', label: L('이벤트', 'Event') },
            { key: 'consumer|consumer_name', label: L('소비자', 'Consumer') },
            { key: 'attempts', label: L('시도', 'Attempts') },
            { key: 'lastError|last_error', label: L('마지막 오류', 'Last error') },
            { key: 'createdAt|created_at', label: L('발생', 'At'), kind: 'datetime' },
          ]}
          actions={[{ label: L('재시도', 'Retry'), tone: 'primary', run: (r) => post(`/v1/admin/outbox/dead-letters/${str(r, 'id')}/retry`, {}) }]}
          empty={<p className="muted">✅ {L('데드레터가 없습니다.', 'No dead letters.')}</p>}
        />
      </Section>
    </>
  );
}
