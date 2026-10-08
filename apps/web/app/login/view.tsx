'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth, extractAccessToken } from '@/lib/auth';
import { ErrorText, Input, Tabs, Alert, Button } from '@/components/ui';
import { SocialButtons, safeNext } from '@/components/auth/social';
import s from '@/components/public/public.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function LoginView() {
  const { L } = useI18n();
  const { authCall, user, ready } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeNext(sp.get('next'));
  const [mode, setMode] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState<{ token: string } | null>(null);
  const [code, setCode] = useState('');
  const [dest, setDest] = useState('');
  const [otpSent, setOtpSent] = useState<{ challengeId?: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [info, setInfo] = useState('');
  const [fe, setFe] = useState<Record<string, string>>({});
  const clear = (k: string) => fe[k] && setFe((x) => ({ ...x, [k]: '' }));
  const hintOf = (k: string, hint?: string) => (fe[k] ? <span className={s.err}>{fe[k]}</span> : hint);
  /** Client-side check before submit: localized inline errors (no browser bubbles), focus the first invalid field. */
  const check = (form: HTMLFormElement, rules: Array<[string, string, (v: string) => string]>) => {
    const out: Record<string, string> = {};
    for (const [k, v, fn] of rules) {
      const m = fn(v);
      if (m) out[k] = m;
    }
    setFe(out);
    if (Object.keys(out).length) {
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return false;
    }
    return true;
  };
  const emailRule = (v: string) => (!v.trim() ? L('이메일을 입력해 주세요.', 'Enter your email.') : !EMAIL_RE.test(v.trim()) ? L('이메일 형식이 올바르지 않아요.', 'Check the email format.') : '');
  const codeRule = (v: string) => (!v.trim() ? L('인증 코드를 입력해 주세요.', 'Enter the code.') : '');

  useEffect(() => {
    if (ready && user && !mfa && !busy) router.replace(next);
  }, [ready, user, mfa, busy, next, router]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 440, margin: '0 auto' }} className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>{L('로그인', 'Log in')}</h1>
        <p className="muted" style={{ margin: 0 }}>{L('다시 오셨군요! 예약과 메시지를 이어서 확인하세요.', 'Welcome back — pick up your trips and messages.')}</p>
      </div>
      {sp.get('linkRequired') && <Alert tone="info">{L('이 이메일로 가입된 계정이 있습니다. 기존 방법으로 로그인한 후 계정 보안에서 소셜 계정을 연결하세요.', 'An account with this email already exists. Sign in with your existing method, then link the social account in Account security.')}</Alert>}
      {sp.get('error') && <Alert tone="error">{L('소셜 로그인을 시작할 수 없습니다. 다른 방법을 이용해 주세요.', 'Social login is unavailable. Try another method.')}</Alert>}
      {mfa ? (
        <form
          className="card stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!check(e.currentTarget, [['code', code, codeRule]])) return;
            void run(async () => {
              await authCall('mfa/challenge', /^\d{6}$/.test(code) ? { code } : { recoveryCode: code });
              router.replace(next);
            });
          }}
        >
          <h2>{L('2단계 인증', 'Two-step verification')}</h2>
          <p className="muted">{L('인증 앱의 6자리 코드 또는 복구 코드를 입력하세요. 관리자 기능은 이 단계가 필요합니다.', 'Enter the 6-digit code from your authenticator or a recovery code. Required for admin features.')}</p>
          <Input label={L('인증 코드', 'Code')} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => { setCode(e.target.value); clear('code'); }} required autoFocus aria-invalid={fe.code ? true : undefined} hint={hintOf('code')} />
          <Button type="submit" variant="primary" loading={busy}>
            {L('확인', 'Verify')}
          </Button>
          <ErrorText error={err} />
          <button type="button" className="btn ghost sm" onClick={() => router.replace(next)}>{L('나중에 하기', 'Skip for now')}</button>
        </form>
      ) : recovery ? (
        <form
          className="card stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!check(e.currentTarget, [['email', email, emailRule]])) return;
            void run(async () => {
              await authCall('password/reset/request', { email: email.trim() });
              setInfo(L('계정이 존재하면 재설정 링크를 이메일로 보냈습니다.', 'If the account exists, we sent a reset link.'));
            });
          }}
        >
          <h2>{L('비밀번호 찾기', 'Account recovery')}</h2>
          <p className="small muted" style={{ margin: 0 }}>{L('가입한 이메일로 비밀번호 재설정 링크를 보내드려요.', 'We’ll email you a link to reset your password.')}</p>
          <Input label={L('이메일', 'Email')} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); clear('email'); }} required aria-invalid={fe.email ? true : undefined} hint={hintOf('email')} />
          <Button type="submit" variant="primary" loading={busy}>
            {L('재설정 링크 보내기', 'Send reset link')}
          </Button>
          {info && <Alert tone="ok">{info}</Alert>}
          <ErrorText error={err} />
          <Button variant="ghost" icon="left" onClick={() => { setRecovery(false); setFe({}); }}>
            {L('로그인으로', 'Back to login')}
          </Button>
        </form>
      ) : (
        <>
          <Tabs
            label={L('로그인 방식', 'Method')}
            value={mode}
            onChange={setMode}
            tabs={[
              { value: 'email', label: L('이메일', 'Email') },
              { value: 'otp', label: L('이메일 코드', 'Email code') },
            ]}
          />
          {mode === 'email' ? (
            <form
              className="stack"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!check(e.currentTarget, [['email', email, emailRule], ['password', password, (v) => (!v ? L('비밀번호를 입력해 주세요.', 'Enter your password.') : '')]])) return;
                void run(async () => {
                  const j = await authCall('login', { email: email.trim(), password });
                  const u = j?.user ?? {};
                  // Accounts with an authenticator are prompted for step-up (AAL2) right after password login.
                  if ((u.mfaEnabled || j?.mfaRequired) && j?.aal !== 'aal2' && extractAccessToken(j)) {
                    setMfa({ token: '' });
                    return;
                  }
                  router.replace(next);
                });
              }}
            >
              <Input label={L('이메일', 'Email')} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); clear('email'); }} required aria-invalid={fe.email ? true : undefined} hint={hintOf('email')} />
              <Input label={L('비밀번호', 'Password')} type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); clear('password'); }} required aria-invalid={fe.password ? true : undefined} hint={hintOf('password')} />
              <Button type="submit" variant="primary" block loading={busy}>
                {busy ? L('로그인 중…', 'Signing in…') : L('로그인', 'Log in')}
              </Button>
              <ErrorText error={err} />
              <button type="button" className="btn ghost sm" onClick={() => { setRecovery(true); setFe({}); }}>
                {L('비밀번호를 잊으셨나요?', 'Forgot password?')}
              </button>
            </form>
          ) : (
            <form
              className="stack"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!check(e.currentTarget, otpSent ? [['code', code, codeRule]] : [['dest', dest, emailRule]])) return;
                void run(async () => {
                  if (!otpSent) {
                    await authCall('otp/request', { email: dest });
                    setOtpSent({});
                    return;
                  }
                  await authCall('otp/verify', { email: dest, code });
                  router.replace(next);
                });
              }}
            >
              <Input label={L('이메일', 'Email')} type="email" inputMode="email" value={dest} onChange={(e) => { setDest(e.target.value); clear('dest'); }} required autoComplete="email" disabled={!!otpSent} aria-invalid={fe.dest ? true : undefined} hint={hintOf('dest', otpSent ? L('받은편지함의 6자리 코드를 입력하세요.', 'Enter the 6-digit code from your inbox.') : L('비밀번호 없이 이메일로 받은 코드로 로그인해요.', 'Sign in with a one-time code sent to your email.'))} />
              {otpSent && <Input label={L('받은 코드', 'Code')} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => { setCode(e.target.value); clear('code'); }} required autoFocus aria-invalid={fe.code ? true : undefined} hint={hintOf('code')} />}
              <Button type="submit" variant="primary" block loading={busy}>
                {otpSent ? L('코드 확인', 'Verify code') : L('코드 받기', 'Send code')}
              </Button>
              {otpSent && (
                <button type="button" className="btn ghost sm" onClick={() => setOtpSent(null)}>
                  {L('다시 보내기', 'Resend')}
                </button>
              )}
              <ErrorText error={err} />
            </form>
          )}
          <div className="row" style={{ gap: 8 }}>
            <hr className="grow" />
            <span className="muted small">{L('또는', 'or')}</span>
            <hr className="grow" />
          </div>
          <SocialButtons next={next} />
          <p className="center">
            {L('처음이신가요?', 'New here?')} <Link href={`/signup?next=${encodeURIComponent(next)}`}>{L('회원가입', 'Sign up')}</Link>
          </p>
        </>
      )}
    </div>
  );
}
