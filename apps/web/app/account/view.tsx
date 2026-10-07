'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { RequireAuth } from '@/components/gate';
import { Kv, PageHeader } from '@/components/ui';

function Inner() {
  const { user, logout } = useAuth();
  const { L } = useI18n();
  const router = useRouter();
  if (!user) return null;
  return (
    <>
      <PageHeader title={L('내 계정', 'My account')} actions={<button className="btn" onClick={async () => { await logout(); router.push('/'); }}>{L('로그아웃', 'Log out')}</button>} />
      <section className="card stack">
        <Kv
          rows={[
            [L('이름', 'Name'), user.displayName],
            [L('이메일', 'Email'), user.email || '—'],
            [L('역할', 'Roles'), user.roles.join(', ')],
            [L('세션 보안 수준', 'Session assurance'), user.aal === 'aal2' ? 'AAL2 (MFA)' : 'AAL1'],
          ]}
        />
      </section>
      <div className="grid" style={{ marginTop: 20 }}>
        <Link className="card link" href="/trips"><h3>{L('내 여행', 'Trips')}</h3><p className="muted small">{L('예약·맞교환·가이드·주문', 'Bookings, exchanges, guides, orders')}</p></Link>
        <Link className="card link" href="/host/onboarding"><h3>{L('호스트 되기', 'Become a host')}</h3><p className="muted small">{L('숙소 등록과 인허가 체크리스트', 'List your place')}</p></Link>
        <Link className="card link" href="/guide/onboarding"><h3>{L('가이드 되기', 'Become a guide')}</h3><p className="muted small">{L('프렌드·자원봉사·유료·전문', 'Friend, volunteer, paid, pro')}</p></Link>
        <Link className="card link" href="/exchange/onboarding"><h3>{L('홈 맞교환 시작', 'Start exchanging')}</h3><p className="muted small">{L('자격 확인과 프로필', 'Eligibility & profile')}</p></Link>
      </div>
    </>
  );
}

export default function AccountView() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}
