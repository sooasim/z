'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { f, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { Alert, Avatar, Badge, Button, ButtonLink, Icon, Kv, PageHeader, Section, type IconName } from '@/components/ui';
import { aalLabel, roleLabel } from '@/components/traveler/labels';

function Inner() {
  const { user, logout } = useAuth();
  const { L, lang } = useI18n();
  const router = useRouter();
  if (!user) return null;
  const u = f<any>(user.raw, 'user') ?? user.raw ?? {};
  const idVerified = f(u, 'identityVerified') === true;
  const emailVerified = f(u, 'emailVerified') === true;
  const roles = user.roles.length ? user.roles : ['USER'];
  const links: Array<{ href: string; icon: IconName; title: string; body: string }> = [
    { href: '/trips', icon: 'bag', title: L('내 여행', 'Trips'), body: L('예약·맞교환·가이드·주문', 'Bookings, exchanges, guides, orders') },
    { href: '/messages', icon: 'chat', title: L('메시지', 'Messages'), body: L('호스트·가이드와 대화', 'Chat with hosts and guides') },
    { href: '/saved', icon: 'heart', title: L('저장 목록', 'Saved'), body: L('찜한 숙소와 컬렉션', 'Favorites and collections') },
    { href: '/payments', icon: 'card', title: L('결제 내역', 'Payments'), body: L('영수증과 환불', 'Receipts and refunds') },
    { href: '/account/security', icon: 'shield', title: L('보안·로그인', 'Security'), body: L('2단계 인증과 로그인 기기', 'Two-step verification and devices') },
    { href: '/account/privacy', icon: 'lock', title: L('개인정보·동의', 'Privacy'), body: L('약관 동의, 데이터 내보내기', 'Consents and data export') },
  ];
  const grow: Array<{ href: string; icon: IconName; title: string; body: string; show: boolean }> = [
    { href: '/host/onboarding', icon: 'home', title: L('호스트 되기', 'Become a host'), body: L('숙소 등록과 인허가 체크리스트', 'List your place with a compliance checklist'), show: !roles.includes('HOST') },
    { href: '/guide/onboarding', icon: 'compass', title: L('가이드 되기', 'Become a guide'), body: L('프렌드·자원봉사·유료·전문', 'Friend, volunteer, paid or pro'), show: !roles.includes('GUIDE') },
    { href: '/exchange/onboarding', icon: 'swap', title: L('홈 맞교환 시작', 'Start exchanging'), body: L('자격 확인과 맞교환 프로필', 'Eligibility and exchange profile'), show: true },
  ];
  return (
    <>
      <PageHeader
        title={L('내 계정', 'My account')}
        actions={
          <Button
            icon="logout"
            onClick={async () => {
              await logout();
              router.push('/');
            }}
          >
            {L('로그아웃', 'Log out')}
          </Button>
        }
      />
      <div className="stack-lg">
        <section className="card stack">
          <div className="row nowrap" style={{ gap: 16 }}>
            <Avatar name={user.displayName} size={64} verified={idVerified} />
            <div className="grow">
              <h2 style={{ margin: 0, fontSize: 'var(--fs-xl)' }}>{user.displayName}</h2>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                {roles.map((r) => (
                  <Badge key={r} tone={r === 'USER' ? undefined : 'info'}>
                    {roleLabel(r, lang)}
                  </Badge>
                ))}
                {idVerified && <Badge tone="ok" icon={<Icon name="check" size={13} />}>{L('본인 확인 완료', 'ID verified')}</Badge>}
              </div>
            </div>
            <ButtonLink size="sm" href="/account/profile" icon="edit">
              {L('프로필 편집', 'Edit profile')}
            </ButtonLink>
          </div>
          <hr style={{ margin: '4px 0' }} />
          <Kv
            rows={[
              [L('이메일', 'Email'), <span key="e">{user.email || '—'} {emailVerified ? <Badge tone="ok">{L('인증됨', 'Verified')}</Badge> : <Badge tone="warn">{L('미인증', 'Unverified')}</Badge>}</span>],
              [L('로그인 보안', 'Sign-in security'), <span key="a">{aalLabel(user.aal, lang)}{!user.mfaEnabled && <> · <Link href="/account/security">{L('2단계 인증 설정하기', 'Set up two-step verification')}</Link></>}</span>],
              [L('가입일', 'Member since'), str(u, 'createdAt') ? new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long' }).format(new Date(str(u, 'createdAt'))) : '—'],
            ]}
          />
        </section>
        {!user.mfaEnabled && (
          <Alert tone="info" icon="shield">
            <div className="row between" style={{ gap: 12 }}>
              <span>{L('인증 앱으로 2단계 인증을 켜면 비밀번호가 유출되어도 계정을 지킬 수 있어요.', 'Turn on two-step verification to protect your account even if your password leaks.')}</span>
              <ButtonLink size="sm" variant="primary" href="/account/security">{L('지금 설정', 'Set up')}</ButtonLink>
            </div>
          </Alert>
        )}
        <Section title={L('바로 가기', 'Shortcuts')}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {links.map((l) => (
              <Link key={l.href} className="card link" href={l.href}>
                <span className="row nowrap" style={{ gap: 12 }}>
                  <span style={{ width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--brand-soft)', color: 'var(--brand)', flex: '0 0 auto' }}>
                    <Icon name={l.icon} size={20} />
                  </span>
                  <span>
                    <strong style={{ display: 'block' }}>{l.title}</strong>
                    <span className="xs muted">{l.body}</span>
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </Section>
        <Section title={L('JETPOOL과 함께하기', 'Do more with JETPOOL')}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {grow
              .filter((g) => g.show)
              .map((g) => (
                <Link key={g.href} className="card link" href={g.href}>
                  <Icon name={g.icon} size={24} style={{ color: 'var(--accent-text)' }} />
                  <strong style={{ display: 'block', marginTop: 8 }}>{g.title}</strong>
                  <span className="xs muted">{g.body}</span>
                </Link>
              ))}
          </div>
        </Section>
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
