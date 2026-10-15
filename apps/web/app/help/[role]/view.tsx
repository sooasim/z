'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { pickPair } from '@/lib/phrases';
import { ROLE_GUIDES, roleBySlug } from '@/lib/roles';
import { DemoLoginButtons, Ticks, useDemoAccounts } from '@/components/auth/demo-accounts';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { NotFoundState } from '@/components/states';
import { Alert, Badge, ButtonLink, HeadingLevel, Icon, PageHeader, Section } from '@/components/ui';

export default function RoleGuideView() {
  const { role } = useParams<{ role: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const { accounts } = useDemoAccounts();
  const g = roleBySlug(String(role));
  if (!g)
    return (
      <NotFoundState
        as="h1"
        title={L('그런 회원 등급은 없어요', 'No such kind of member')}
        body={L('주소를 다시 확인해 주세요.', 'Check the address.')}
        back={{ href: '/help', label: L('사용 안내로', 'Back to the guide') }}
      />
    );
  const demoKeys = g.demoKeys.filter((k) => accounts.some((a) => a.key === k));
  const isMine = !!user && (g.roles.length === 0 || g.roles.some((r) => user.roles.includes(r)));
  const others = ROLE_GUIDES.filter((x) => x.slug !== g.slug);
  return (
    <>
      <Breadcrumbs items={[{ href: '/help', label: L('사용 안내', 'How to use') }, { label: pickPair(g.name, lang) ?? g.slug }]} />
      <PageHeader title={pickPair(g.name, lang) ?? g.slug} subtitle={pickPair(g.tagline, lang)} />
      <p style={{ fontSize: 'var(--fs-lg)', lineHeight: 1.75, marginTop: 0 }}>{pickPair(g.intro, lang)}</p>
      <p className="row small muted" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span>{L('계정에 붙는 역할', 'Roles on the account')}:</span>
        {g.roles.length ? g.roles.map((r) => <Badge key={r} tone="info">{r}</Badge>) : <Badge tone="info">USER</Badge>}
        {isMine && <Badge tone="ok">{L('지금 이 등급으로 로그인되어 있어요', 'You are signed in as this')}</Badge>}
      </p>

      {demoKeys.length > 0 && (
        <Section title={L('이 등급으로 체험하기', 'Try it as this member')} id="try">
          <p className="small muted" style={{ marginTop: 0 }}>
            {L('비밀번호 없이 로그인하고 바로 이 등급의 첫 화면으로 이동합니다.', 'Signs in without a password and lands on this role’s main screen.')}
          </p>
          <DemoLoginButtons only={demoKeys} wide />
        </Section>
      )}

      <Section title={L('이 등급이 쓰는 화면', 'The screens this member uses')}>
        <HeadingLevel level={3}>
          <ol className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 16 }}>
            {g.screens.map((sc, i) => {
              const dynamic = sc.href.includes('[');
              return (
                <li key={`${sc.href}-${i}`} className="card stack" style={{ gap: 8 }}>
                  <div className="row between" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>{pickPair(sc.name, lang)}</h3>
                    {dynamic ? <code className="xs muted">{sc.href}</code> : <Link className="xs" href={sc.href}>{sc.href}</Link>}
                  </div>
                  <p className="small" style={{ margin: 0, lineHeight: 1.7 }}><Ticks text={pickPair(sc.what, lang)} /></p>
                  {sc.actions && sc.actions.length > 0 && (
                    <ul className="stack small" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
                      {sc.actions.map((a, j) => (
                        <li key={j} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                          <Icon name="circle" size={14} style={{ flex: '0 0 auto', marginTop: 4, color: 'var(--brand)' }} />
                          <span className="muted"><Ticks text={pickPair(a, lang)} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </HeadingLevel>
      </Section>

      <Section title={L('따라 해 보기', 'Walk through it')}>
        <ol className="stack" style={{ paddingLeft: 20, margin: 0, gap: 10 }}>
          {g.steps.map((st, i) => (
            <li key={i} style={{ lineHeight: 1.7 }}><Ticks text={pickPair(st, lang)} /></li>
          ))}
        </ol>
      </Section>

      {g.notes && g.notes.length > 0 && (
        <Section title={L('알아 두면 좋은 것', 'Worth knowing')}>
          <div className="stack" style={{ gap: 10 }}>
            {g.notes.map((n, i) => (
              <Alert key={i} tone="info"><Ticks text={pickPair(n, lang)} /></Alert>
            ))}
          </div>
        </Section>
      )}

      <Section title={L('다른 등급 보기', 'Other kinds of member')}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {others.map((o) => (
            <ButtonLink key={o.slug} href={`/help/${o.slug}`} size="sm" icon={o.icon as any}>
              {pickPair(o.name, lang)}
            </ButtonLink>
          ))}
        </div>
      </Section>
    </>
  );
}
