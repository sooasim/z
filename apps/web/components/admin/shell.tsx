'use client';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { RequireAuth } from '@/components/gate';
import { SideNav } from '@/components/shell';
import { MfaPrompt } from '@/components/states';
import { Alert } from '@/components/ui';

/** The admin console's own sign-in page — staff come in here instead of the member `/login`. */
export const ADMIN_LOGIN_PATH = '/admin/login';

export function AdminShell({ children }: { children: ReactNode }) {
  const { L } = useI18n();
  const { user } = useAuth();
  // `trailingSlash` is on for the static export, so the path arrives as `/admin/login/` there and `/admin/login` in dev.
  const pathname = (usePathname() || '').replace(/\/+$/, '');
  // The sign-in page lives under /admin, so it has to render outside the staff gate and the console chrome.
  if (pathname === ADMIN_LOGIN_PATH) return <>{children}</>;
  const ops = L('운영', 'Operations');
  const commerce = L('상품·주문', 'Catalog & orders');
  const people = L('회원·예약', 'People & bookings');
  const trust = L('신뢰·안전', 'Trust & safety');
  const money = L('결제·정산', 'Money');
  const content = L('콘텐츠', 'Content');
  const direct = L('직영 운영', 'Run in-house');
  const platform = L('플랫폼', 'Platform');
  return (
    <RequireAuth staff loginHref={ADMIN_LOGIN_PATH}>
      <div className="admin-shell">
        <aside className="admin-side" aria-label={L('관리자 메뉴', 'Admin navigation')}>
          <div className="brand"><span className="logo" role="img" aria-label="JETPOOL" /> <span className="badge accent">ADMIN</span></div>
          <SideNav
            label={L('관리자', 'Admin')}
            items={[
              { href: '/admin', label: L('개요', 'Overview'), icon: 'chart', group: ops },
              { href: '/admin/analytics', label: L('분석', 'Analytics'), icon: 'chart' },
              { href: '/admin/support', label: L('고객 문의', 'Support desk'), icon: 'chat' },
              { href: '/admin/travel/orders', label: L('주문 접수', 'Order intake'), icon: 'bag', group: commerce },
              { href: '/admin/suppliers', label: L('공급사 관리', 'Suppliers'), icon: 'users' },
              { href: '/admin/listings', label: L('숙소 관리', 'Stay listings'), icon: 'home' },
              { href: '/admin/members', label: L('회원 관리', 'Members'), icon: 'user', group: people },
              { href: '/admin/bookings', label: L('예약 관리', 'Bookings'), icon: 'calendar' },
              { href: '/admin/compliance', label: L('준수 심사', 'Compliance'), icon: 'shield', group: trust },
              { href: '/admin/verifications', label: L('본인·사업자 인증', 'Verifications'), icon: 'user' },
              { href: '/admin/disputes', label: L('분쟁', 'Disputes'), icon: 'alert' },
              { href: '/admin/security', label: L('보안·리스크', 'Security & risk'), icon: 'lock' },
              { href: '/admin/payments', label: L('결제', 'Payments'), icon: 'card', group: money },
              { href: '/admin/refunds', label: L('환불', 'Refunds'), icon: 'coin' },
              { href: '/admin/settlements', label: L('정산 승인', 'Settlements'), icon: 'coin' },
              { href: '/admin/ledger', label: L('원장', 'Ledger'), icon: 'doc' },
              { href: '/admin/finance/rules', label: L('수수료·세금 규칙', 'Fee & tax rules'), icon: 'settings' },
              { href: '/admin/products', label: L('관광 상품', 'Travel products'), icon: 'ticket', group: content },
              { href: '/admin/home', label: L('메인 첫 페이지', 'Main page'), icon: 'home' },
              { href: '/admin/cms', label: L('CMS · 리다이렉트', 'CMS & redirects'), icon: 'doc' },
              // Head office running its own inventory. These are the host tools, which a staff account may
              // use as itself: a stay listed here belongs to the signed-in admin account, and publishing it
              // still goes through the same compliance predicates as a member's listing (invariant 7).
              { href: '/host/listings', label: L('직영 숙소', 'In-house stays'), icon: 'bed', group: direct },
              { href: '/host/calendar', label: L('직영 숙소 달력·요금', 'Stay calendar & rates'), icon: 'calendar' },
              { href: '/host/reservations', label: L('직영 숙소 예약', 'Stay reservations'), icon: 'list' },
              { href: '/admin/audit', label: L('감사 로그', 'Audit logs'), icon: 'doc', group: platform },
              { href: '/admin/access', label: L('권한 관리', 'Access & roles'), icon: 'user' },
              { href: '/admin/config', label: L('기능 플래그', 'Feature flags'), icon: 'settings' },
              { href: '/admin/ops', label: L('시스템 상태', 'System health'), icon: 'chart' },
            ]}
          />
        </aside>
        <div style={{ minWidth: 0 }}>
          {/* Only warn where the AAL1 session is actually a problem: with STAFF_MFA_REQUIRED=false the
              staff routes work at AAL1, so a standing warning would be noise with no action behind it. */}
          {user && user.aal !== 'aal2' && user.staffMfaRequired && (
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
