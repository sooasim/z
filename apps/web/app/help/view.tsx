'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { pickPair } from '@/lib/phrases';
import { ROLE_GUIDES } from '@/lib/roles';
import { Ticks, useDemoAccounts } from '@/components/auth/demo-accounts';
import { Badge, HeadingLevel, Icon, PageHeader, Section } from '@/components/ui';

/** Which guides describe the signed-in account, so the hub can say “you are here”. */
function mine(roles: string[]) {
  const has = (r: string) => roles.includes(r);
  return ROLE_GUIDES.filter((g) => (g.roles.length === 0 ? true : g.roles.some(has)));
}

export default function HelpHubView() {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const { accounts } = useDemoAccounts();
  const demo = accounts.length > 0;
  const current = user ? mine(user.roles) : [];
  return (
    <>
      <PageHeader
        title={L('사용 안내', 'How to use JETPOOL')}
        subtitle={L(
          'JETPOOL은 유료숙박·홈 맞교환·가이드 프렌드·여행 상품을 한 계정으로 씁니다. 같은 화면도 회원 등급에 따라 다르게 보이기 때문에, 등급마다 어떤 페이지가 열리고 각 버튼이 무엇을 하는지 모아 두었어요.',
          'Four marketplaces behind one account: paid stays, home exchange, guide friends and travel products. The same screen shows a different product depending on which roles the account holds — so here is what each kind of member sees, and what each button does.',
        )}
      />
      {user && current.length > 0 && (
        <p className="small muted" style={{ marginTop: -8 }}>
          {L('지금 로그인한 계정', 'Signed in as')}: <strong>{user.displayName}</strong>{' '}
          {current.map((g) => (
            <Badge key={g.slug} tone="info">{pickPair(g.name, lang)}</Badge>
          ))}
        </p>
      )}
      <Section title={L('회원 등급', 'Kinds of member')}>
        <HeadingLevel level={3}>
          <div className="grid">
            {ROLE_GUIDES.map((g) => (
              <article key={g.slug} className="card stack" style={{ gap: 10 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Icon name={g.icon as any} size={20} style={{ color: 'var(--brand)' }} />
                  <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>{pickPair(g.name, lang)}</h3>
                </div>
                <p className="small muted" style={{ margin: 0 }}>{pickPair(g.tagline, lang)}</p>
                <p className="xs muted" style={{ margin: 0 }}>
                  {L(`화면 ${g.screens.length}개`, `${g.screens.length} screens`)}
                  {g.roles.length > 0 && ` · ${g.roles.join(', ')}`}
                </p>
                <div className="row" style={{ gap: 8 }}>
                  <Link className="btn sm" href={`/help/${g.slug}`}>
                    {L('사용법 보기', 'Read the guide')}
                  </Link>
                  {demo && (
                    <Link className="btn sm ghost" href={`/help/${g.slug}#try`}>
                      {L('이 등급으로 체험', 'Try this role')}
                    </Link>
                  )}
                </div>
              </article>
            ))}
          </div>
        </HeadingLevel>
      </Section>
      <Section title={L('어느 등급이든 똑같은 것', 'The same for everyone')}>
        <ul className="stack small" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 10 }}>
          {[
            [['헤더 메뉴', 'The header menu'], ['숙소·맞교환·가이드·여행상품·전세기 다섯 갈래가 항상 열려 있습니다. 로그인하면 오른쪽 아바타 메뉴에 내 여행·메시지·저장함·계정이 생기고, 가진 역할에 따라 호스트 센터·가이드 센터·공급사 센터·정산이 더해져요.', 'The five marketplaces are always open. Signing in adds trips, messages, saved and account to the avatar menu — plus a host, guide, supplier or finance center for the roles you hold.']],
            [['언어', 'Language'], ['지구본 메뉴에서 한국어·English·日本語·简体中文·Tiếng Việt을 고릅니다. 회원이 쓴 글은 기계 번역으로 읽는 언어에 맞춰 보여 줍니다.', 'The globe menu switches between Korean, English, Japanese, Chinese and Vietnamese. Member-written text is machine-translated into the language you read.']],
            [['저장함과 하트', 'Hearts and saved'], ['어느 목록에서든 하트를 누르면 저장함(/saved)에 모입니다.', 'The heart on any card collects it into /saved.']],
            [['메시지', 'Messages'], ['예약·맞교환·가이드 요청마다 대화가 하나씩 열립니다. 전화번호·이메일 같은 연락처는 플랫폼 보호를 위해 막혀 있어요.', 'One thread per booking, exchange or guide request. Phone numbers and e-mail addresses are blocked on purpose.']],
            [['2단계 인증', 'Two-step verification'], ['정산 계좌 등록과 운영자 화면은 인증 앱 등록(AAL2)을 요구합니다.', 'Payout accounts and the admin console need an authenticator (AAL2).']],
          ].map(([t, d], i) => (
            <li key={i}>
              <strong>{pickPair(t as any, lang)}</strong>
              <br />
              <span className="muted"><Ticks text={pickPair(d as any, lang)} /></span>
            </li>
          ))}
        </ul>
      </Section>
      {demo && (
        <p className="card flat small muted" style={{ marginTop: 'var(--sp-6)' }}>
          {L('이 사이트는 데모입니다. 결제는 테스트 모드이고, 아래 버튼으로 어떤 등급이든 비밀번호 없이 로그인할 수 있어요.', 'This is a demo: payments run in test mode and you can sign in as any kind of member without a password.')}{' '}
          <Link href="/login">{L('로그인 화면에서 테스트 계정 보기', 'See the test accounts on the login page')}</Link>
        </p>
      )}
    </>
  );
}
