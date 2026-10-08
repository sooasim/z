'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { ErrorText, Illustration, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/errors';
import { safeNext } from '@/components/auth/social';

export default function OAuthCallbackView() {
  const { provider } = useParams<{ provider: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const { L } = useI18n();
  const { authCall } = useAuth();
  const [err, setErr] = useState<unknown>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const code = sp.get('code');
    const state = sp.get('state');
    if (sp.get('error') || !code) {
      setErr(new Error(sp.get('error_description') || L('소셜 로그인이 취소되었습니다.', 'Social login was cancelled.')));
      return;
    }
    (async () => {
      try {
        const j = await authCall(`oauth/${provider}/callback`, { code, state });
        let next = '/';
        try {
          next = safeNext(sessionStorage.getItem('jp_next'));
          sessionStorage.removeItem('jp_next');
        } catch {
          /* ignore */
        }
        if (j?.linked) router.replace('/account/security?linked=1');
        else router.replace(safeNext(j?.returnTo) !== '/' ? safeNext(j?.returnTo) : next);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'ACCOUNT_LINK_REQUIRED') {
          router.replace(`/login?linkRequired=${provider}&next=${encodeURIComponent(`/account/security?link=${provider}`)}`);
          return;
        }
        setErr(e);
      }
    })();
  }, [provider, sp, authCall, router, L]);
  return (
    <div style={{ maxWidth: 440, margin: '0 auto' }}>
      {err ? (
        <div className="state" role="alert">
          <Illustration name="lock" />
          <h1>{L('소셜 로그인을 완료하지 못했어요', 'We couldn’t finish signing you in')}</h1>
          <ErrorText error={err} />
          <div className="actions">
            <Link className="btn primary" href="/login">
              {L('다시 로그인하기', 'Try logging in again')}
            </Link>
            <Link className="btn ghost" href="/support">
              {L('고객센터', 'Help centre')}
            </Link>
          </div>
        </div>
      ) : (
        <>
          <h1 className="sr-only">{L('로그인 처리 중', 'Signing you in')}</h1>
          <Spinner label={L('로그인 처리 중…', 'Signing you in…')} />
        </>
      )}
    </div>
  );
}
