'use client';
/**
 * One-click sign-in for the seeded demo accounts (CORE-01 `DEMO_LOGINS`).
 *
 * Four marketplaces behind one account means the same screen is a different product depending on who is
 * looking, and typing an address and a shared password nine times is the slowest way to find that out. The API
 * lists the accounts an environment actually has and opens a session from a role key — no password is ever sent
 * to the browser, and on a deployment without the switch the list comes back empty and nothing renders here.
 */
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { items, str, arr } from '@/lib/shape';
import { pickPair } from '@/lib/phrases';
import { roleByDemoKey, type RoleGuide } from '@/lib/roles';
import { Alert, Button, Icon } from '@/components/ui';
import { ErrorText } from '@/components/ui';

/**
 * Render `backticked` spans in guide copy as code. The copy names routes and shell commands, and a reader
 * should see them set apart rather than see the backticks.
 */
export function Ticks({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </>
  );
}

export interface DemoAccount {
  key: string;
  email: string;
  displayName: string;
  roles: string[];
  guide?: RoleGuide;
}

/** The demo accounts this deployment offers, newest state of the gate included. Empty list = feature off. */
export function useDemoAccounts(): { accounts: DemoAccount[]; loading: boolean } {
  const st = useApi<any>('/v1/auth/demo-accounts');
  const accounts = items(st.data)
    .map((r: any) => {
      const key = str(r, 'key');
      return { key, email: str(r, 'email'), displayName: str(r, 'displayName'), roles: arr<string>(r, 'roles'), guide: roleByDemoKey(key) };
    })
    .filter((a: DemoAccount) => a.key);
  return { accounts, loading: st.loading && !st.data };
}

/**
 * The buttons themselves. `only` narrows to one role's accounts (the role guide pages use that), and `next`
 * overrides where the session lands — by default each role goes to the screen it actually works in.
 */
export function DemoLoginButtons({ only, next, compact, wide }: { only?: string[]; next?: string; compact?: boolean; wide?: boolean }) {
  const { L, lang } = useI18n();
  const { authCall } = useAuth();
  const { accounts } = useDemoAccounts();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const list = only ? accounts.filter((a) => only.includes(a.key)) : accounts;
  if (!list.length) return null;

  const signIn = async (a: DemoAccount) => {
    setErr(null);
    setBusy(a.key);
    try {
      await authCall('demo-login', { key: a.key });
      // A full load, not a client route change: switching persona changes what every screen may read, and the
      // login page's own "signed in → go to next" effect would otherwise race this one to a different place.
      window.location.assign(next || a.guide?.home || '/');
    } catch (e) {
      setErr(e);
      setBusy('');
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className={wide ? 'demo-accounts wide' : 'demo-accounts'}>
        {list.map((a) => {
          const name = a.guide ? pickPair(a.guide.name, lang) : a.displayName;
          const sub = a.guide ? pickPair(a.guide.tagline, lang) : a.email;
          return (
            <button key={a.key} type="button" className="card flat demo-account" onClick={() => void signIn(a)} disabled={!!busy} data-loading={busy === a.key ? 'true' : undefined}>
              <Icon name={(a.guide?.icon as any) || 'user'} size={18} />
              <span className="demo-account-text">
                <strong>{name}</strong>
                {!compact && <span className="xs muted says">{sub}</span>}
                <span className="xs muted who">{a.displayName} · {a.email}</span>
              </span>
              <Icon name="right" size={16} />
            </button>
          );
        })}
      </div>
      <ErrorText error={err} />
    </div>
  );
}

/** The whole block as the login page shows it: heading, warning, buttons and a link to the guide. */
export function DemoLoginPanel({ next }: { next?: string }) {
  const { L } = useI18n();
  const { accounts, loading } = useDemoAccounts();
  if (loading || !accounts.length) return null;
  return (
    <section className="card stack" aria-labelledby="demo-accounts" style={{ background: 'var(--surface-2)' }}>
      <div>
        <h2 id="demo-accounts" style={{ margin: '0 0 4px', fontSize: 'var(--fs-md)' }}>
          {L('테스트 계정으로 바로 둘러보기', 'Try it as any kind of member')}
        </h2>
        <p className="small muted" style={{ margin: 0 }}>
          {L('비밀번호 없이 한 번에 로그인합니다. 회원 등급마다 보이는 화면이 다르니 바꿔 가며 확인해 보세요.', 'One click, no password. Each kind of member sees a different product — switch between them.')}
        </p>
      </div>
      <DemoLoginButtons next={next} />
      <Alert tone="info">
        {L('데모 환경에서만 보이는 기능이에요. 실제 운영 환경에서는 이 버튼이 나타나지 않습니다.', 'Demo deployments only — these buttons do not exist in production.')}
      </Alert>
      <p className="small" style={{ margin: 0 }}>
        <Link href="/help">{L('회원 등급별 사용 안내 보기 →', 'Read the guide for each kind of member →')}</Link>
      </p>
    </section>
  );
}
