'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth, extractAccessToken, STAFF_ROLES } from '@/lib/auth';
import { MfaPrompt } from '@/components/states';
import { Alert, Button, ErrorText, Input } from '@/components/ui';

/**
 * ADMIN · console sign-in (`/admin/login`).
 *
 * Separate from the member `/login` on purpose: staff sign in with a short handle (`users.username`, e.g.
 * `admin`) rather than an address, there is no sign-up or social path, and the AAL2 step-up that every staff
 * route needs is part of the same screen instead of a warning after the fact.
 */

const LOOKS_LIKE_EMAIL = /@/;
/** Anything under /admin, so a bounced request returns to the page the user actually asked for. */
const safeAdminNext = (v: string | null): string => (v && /^\/admin(\/|$)/.test(v) && !v.startsWith('//') ? v : '/admin');

export default function AdminLoginView() {
  const { L } = useI18n();
  const { authCall, user, ready, isStaff, logout } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeAdminNext(sp.get('next'));
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [fe, setFe] = useState<{ loginId?: string; password?: string }>({});

  const signedInStaff = ready && !!user && isStaff;
  useEffect(() => {
    // Already a staff session at AAL2 — nothing left to do here.
    if (signedInStaff && user?.aal === 'aal2' && !busy) router.replace(next);
  }, [signedInStaff, user?.aal, busy, next, router]);

  if (stepUp || (signedInStaff && user?.aal !== 'aal2')) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack-lg">
        <h1>{L('관리자 2단계 인증', 'Admin two-step verification')}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {L('관리자 작업에는 MFA 인증(AAL2)이 필요합니다. 인증 앱의 6자리 코드 또는 복구 코드를 입력하세요.', 'Admin actions require MFA (AAL2). Enter the 6-digit code from your authenticator, or a recovery code.')}
        </p>
        <div className="card">
          <MfaPrompt as="h2" onDone={() => router.replace(next)} />
        </div>
        <Button variant="ghost" onClick={() => void logout().then(() => setStepUp(false))}>
          {L('다른 계정으로 로그인', 'Sign in as someone else')}
        </Button>
      </div>
    );
  }

  if (ready && user && !isStaff) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack-lg">
        <h1>{L('관리자 콘솔', 'Admin console')}</h1>
        <Alert tone="error">{L('이 계정에는 운영진 권한이 없습니다. 관리자 계정으로 다시 로그인해 주세요.', 'This account has no staff role. Sign in with an admin account.')}</Alert>
        <div className="row">
          <Button variant="primary" onClick={() => void logout()}>
            {L('로그아웃하고 다시 로그인', 'Sign out and try again')}
          </Button>
          <Link className="btn ghost" href="/">
            {L('홈으로', 'Go home')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 440, margin: '0 auto' }} className="stack-lg">
      <div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="logo" role="img" aria-label="JETPOOL" />
          <span className="badge accent">ADMIN</span>
        </div>
        <h1 style={{ marginBottom: 4 }}>{L('관리자 로그인', 'Admin sign-in')}</h1>
        <p className="muted" style={{ margin: 0 }}>{L('운영진 계정으로만 들어올 수 있습니다. 아이디 또는 이메일로 로그인하세요.', 'Staff accounts only. Sign in with your admin id or email.')}</p>
      </div>
      <form
        className="card stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const id = loginId.trim();
          const errs: typeof fe = {};
          if (!id) errs.loginId = L('아이디 또는 이메일을 입력해 주세요.', 'Enter your admin id or email.');
          if (!password) errs.password = L('비밀번호를 입력해 주세요.', 'Enter your password.');
          setFe(errs);
          if (Object.keys(errs).length) return;
          setBusy(true);
          setErr(null);
          void (async () => {
            try {
              // The API takes `email` or `username`; a value with '@' is an address, anything else a handle.
              const j = await authCall('login', LOOKS_LIKE_EMAIL.test(id) ? { email: id, password } : { username: id.toLowerCase(), password });
              const roles: string[] = Array.isArray(j?.user?.roles) ? j.user.roles : [];
              // A member who signs in here must not be walked through an MFA step-up: the "no staff role"
              // branch above renders on the next tick instead.
              if (!roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r))) return;
              if (j?.aal !== 'aal2' && extractAccessToken(j)) {
                setStepUp(true);
                return;
              }
              router.replace(next);
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <Input
          label={L('관리자 아이디 또는 이메일', 'Admin id or email')}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={loginId}
          onChange={(e) => {
            setLoginId(e.target.value);
            setFe((s) => ({ ...s, loginId: '' }));
          }}
          required
          autoFocus
          aria-invalid={fe.loginId ? true : undefined}
          hint={fe.loginId || L('예: admin', 'e.g. admin')}
        />
        <Input
          label={L('비밀번호', 'Password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setFe((s) => ({ ...s, password: '' }));
          }}
          required
          aria-invalid={fe.password ? true : undefined}
          hint={fe.password}
        />
        <Button type="submit" variant="primary" block loading={busy}>
          {busy ? L('로그인 중…', 'Signing in…') : L('로그인', 'Log in')}
        </Button>
        <ErrorText error={err} />
      </form>
      <p className="small muted center">
        {L('회원 계정으로 로그인하시려면', 'Looking for the member sign-in?')} <Link href="/login">{L('일반 로그인', 'Member login')}</Link>
      </p>
    </div>
  );
}
