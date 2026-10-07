'use client';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { RequireAuth } from '@/components/gate';
import { SideNav } from '@/components/shell';
import { MfaPrompt } from '@/components/states';
import { Alert } from '@/components/ui';

export function AdminShell({ children }: { children: ReactNode }) {
  const { L } = useI18n();
  const { user } = useAuth();
  const ops = L('운영', 'Operations');
  const trust = L('신뢰·안전', 'Trust & safety');
  const money = L('결제·정산', 'Money');
  const content = L('콘텐츠', 'Content');
  const platform = L('플랫폼', 'Platform');
  return (
    <RequireAuth staff>
      <div className="admin-shell">
        <aside className="admin-side" aria-label={L('관리자 메뉴', 'Admin navigation')}>
          <div className="brand"><span className="wordmark" style={{ color: 'inherit', fontSize: 'var(--fs-sm)' }}><span className="dot" aria-hidden="true" />JETPOOL</span> <span className="badge accent">ADMIN</span></div>
          <SideNav
            label={L('관리자', 'Admin')}
            items={[
              { href: '/admin', label: L('개요', 'Overview'), icon: 'chart', group: ops },
              { href: '/admin/analytics', label: L('분석', 'Analytics'), icon: 'chart' },
              { href: '/admin/support', label: L('고객 문의', 'Support desk'), icon: 'chat' },
              { href: '/admin/compliance', label: L('준수 심사', 'Compliance'), icon: 'shield', group: trust },
              { href: '/admin/verifications', label: L('본인·사업자 인증', 'Verifications'), icon: 'user' },
              { href: '/admin/disputes', label: L('분쟁', 'Disputes'), icon: 'alert' },
              { href: '/admin/security', label: L('보안·리스크', 'Security & risk'), icon: 'lock' },
              { href: '/admin/payments', label: L('결제', 'Payments'), icon: 'card', group: money },
              { href: '/admin/refunds', label: L('환불', 'Refunds'), icon: 'coin' },
              { href: '/admin/settlements', label: L('정산 승인', 'Settlements'), icon: 'coin' },
              { href: '/admin/ledger', label: L('원장', 'Ledger'), icon: 'doc' },
              { href: '/admin/finance/rules', label: L('수수료·세금 규칙', 'Fee & tax rules'), icon: 'settings' },
              { href: '/admin/cms', label: L('CMS · 리다이렉트', 'CMS & redirects'), icon: 'doc', group: content },
              { href: '/admin/audit', label: L('감사 로그', 'Audit logs'), icon: 'doc', group: platform },
              { href: '/admin/access', label: L('권한 관리', 'Access & roles'), icon: 'user' },
              { href: '/admin/config', label: L('기능 플래그', 'Feature flags'), icon: 'settings' },
              { href: '/admin/ops', label: L('시스템 상태', 'System health'), icon: 'chart' },
            ]}
          />
        </aside>
        <div style={{ minWidth: 0 }}>
          {user && user.aal !== 'aal2' && (
            <details className="card flat" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>⚠️ {L('현재 세션은 AAL1입니다. 관리자 작업에는 MFA 인증이 필요합니다.', 'This session is AAL1 — admin actions need MFA.')}</summary>
              <div style={{ marginTop: 12 }}><MfaPrompt /></div>
            </details>
          )}
          {children}
          <Alert tone="info">{L('모든 관리자 조회·변경은 감사 로그에 기록됩니다.', 'Every admin read and change is audit-logged.')}</Alert>
        </div>
      </div>
    </RequireAuth>
  );
}
