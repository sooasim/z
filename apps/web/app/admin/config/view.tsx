'use client';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { item, str, f } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';
import { Section } from '@/components/ui';
import { ResourceTable } from '@/components/table';

const LEGAL_GATED = ['stay.paid_booking', 'exchange.enabled', 'guide.paid', 'travel.commerce', 'charter.direct_booking', 'ai.assistant', 'ai.recommendations', 'payout.automatic', 'integrations.pms'];

export default function AdminConfigView() {
  const { L } = useI18n();
  const pub = useApi<any>('/v1/config/public');
  return (
    <>
      <AdminListPage
        title={L('기능 플래그 · 설정', 'Feature flags & configuration')}
        subtitle={L('법무·사업 게이트(G9) 플래그는 기본 OFF입니다. 변경은 사유와 함께 감사 기록됩니다.', 'Legal/business-gated (G9) flags default OFF. Changes are audited with a reason.')}
        path="/v1/admin/feature-flags"
        search={false}
        columns={[
          { key: 'flagKey|flag_key', label: L('플래그', 'Flag'), render: (r) => <span className="mono">{str(r, 'flagKey', 'flag_key')}{LEGAL_GATED.includes(str(r, 'flagKey', 'flag_key')) && <span className="badge warn" style={{ marginLeft: 6 }}>G9</span>}</span> },
          { key: 'enabled', label: L('상태', 'State'), render: (r) => (f(r, 'enabled') ? <span className="pill ok">ON</span> : <span className="pill neutral">OFF</span>) },
          { key: 'description', label: L('설명', 'Description') },
          { key: 'rules', label: L('대상 규칙', 'Targeting'), kind: 'json' },
          { key: 'updatedBy|updated_by', label: L('변경자', 'Updated by'), kind: 'id' },
          { key: 'updatedAt|updated_at', label: L('변경일', 'Updated'), kind: 'datetime' },
        ]}
        actions={[
          { label: L('켜기', 'Enable'), tone: 'primary', when: (r) => !f(r, 'enabled'), reason: L('활성화 사유 (G9 플래그는 승인 근거 필수)', 'Reason (G9 flags need an approval reference)'), confirm: L('운영 환경에 즉시 반영됩니다. 계속할까요?', 'Applies immediately. Continue?'), run: (r, reason) => api('/v1/admin/feature-flags', { method: 'PATCH', body: { flagKey: str(r, 'flagKey', 'flag_key'), enabled: true, reason } }) },
          { label: L('끄기', 'Disable'), tone: 'danger', when: (r) => !!f(r, 'enabled'), reason: L('비활성화 사유', 'Reason'), run: (r, reason) => api('/v1/admin/feature-flags', { method: 'PATCH', body: { flagKey: str(r, 'flagKey', 'flag_key'), enabled: false, reason } }) },
        ]}
      />
      <Section title={L('운영 설정 (유효기간·승인 기반)', 'Runtime configuration (effective-dated, approved)')}>
        <ResourceTable
          path="/v1/admin/config"
          columns={[
            { key: 'key|config_key', label: L('키', 'Key'), render: (r) => <span className="mono">{str(r, 'key', 'configKey', 'config_key')}</span> },
            { key: 'value', label: L('값', 'Value'), kind: 'json' },
            { key: 'effectiveFrom|effective_from', label: L('적용', 'Effective'), kind: 'datetime' },
            { key: 'status|approved', label: L('상태', 'Status') },
          ]}
          empty={<p className="muted">{L('설정 항목이 없습니다.', 'No configuration entries.')}</p>}
        />
      </Section>
      <Section title={L('공개 설정 (클라이언트에 노출)', 'Public config (exposed to clients)')}>
        <pre className="card mono" style={{ overflow: 'auto', maxHeight: 320 }}>{pub.loading ? '…' : JSON.stringify(item(pub.data) ?? pub.data ?? {}, null, 2)}</pre>
      </Section>
    </>
  );
}
