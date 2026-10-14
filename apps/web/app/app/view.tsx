'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { AppInstall } from '@/components/public/AppInstall';
import { safeNext } from '@/components/auth/social';
import { Spinner } from '@/components/ui';

/**
 * The app entry — `start_url` in the manifest, so this is what the home-screen icon opens.
 *
 * Launch mode (no query): wait for the one refresh the AuthProvider does on mount, then either drop the reader
 * into the app or show the app login screen. The refresh token is an httpOnly cookie the BFF renews on every
 * use (`lib/bff.ts`), which is what makes "sign in once, stay signed in until you log out" true across launches:
 * nothing is kept in JS, so nothing is lost when the app is closed, and only a logout clears the cookie.
 *
 * Install mode (`?install=1`): where an in-app browser lands after escaping to Chrome/Safari — the one thing
 * left to do there is finish putting the icon on the home screen.
 */
export default function AppEntryView() {
  const { L } = useI18n();
  const { ready, user } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const install = sp.get('install') === '1';
  const next = safeNext(sp.get('next'));

  useEffect(() => {
    if (install || !ready) return;
    router.replace(user ? next : `/login?app=1&next=${encodeURIComponent(next)}`);
  }, [install, ready, user, next, router]);

  if (install) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack-lg">
        <AppInstall variant="page" />
        <Link className="btn ghost block" href="/login?app=1">
          {L('먼저 로그인하기', 'Sign in first')}
        </Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', textAlign: 'center' }} className="stack-lg">
      <img src="/icons/icon.svg" alt="" width={72} height={72} style={{ borderRadius: 18, margin: '0 auto' }} />
      <div>
        <h1 style={{ marginBottom: 4 }}>JETPOOL</h1>
        <p className="muted" style={{ margin: 0 }}>
          {ready && user ? L('로그인 상태를 확인했어요. 이동 중…', 'Signed in — taking you in…') : L('앱으로 접속하는 중…', 'Opening the app…')}
        </p>
      </div>
      <Spinner label={L('접속 중', 'Connecting')} />
      <Link className="btn ghost block" href="/login?app=1">
        {L('로그인 화면으로', 'Go to the login screen')}
      </Link>
    </div>
  );
}
