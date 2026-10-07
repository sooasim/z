'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth, extractAccessToken } from '@/lib/auth';
import { ErrorText, Input, Tabs, Alert } from '@/components/ui';
import { SocialButtons, safeNext } from '@/components/auth/social';

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

  useEffect(() => {
    if (ready && user && !mfa) router.replace(next);
  }, [ready, user, mfa, next, router]);

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
      <h1>{L('로그인', 'Log in')}</h1>
      {sp.get('error') && <Alert tone="error">{L('소셜 로그인을 시작할 수 없습니다. 다른 방법을 이용해 주세요.', 'Social login is unavailable. Try another method.')}</Alert>}
      {mfa ? (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await authCall('mfa/verify', { mfaToken: mfa.token, challengeToken: mfa.token, code });
              router.replace(next);
            });
          }}
        >
          <h2>{L('2단계 인증', 'Two-step verification')}</h2>
          <p className="muted">{L('인증 앱의 6자리 코드 또는 복구 코드를 입력하세요.', 'Enter the 6-digit code from your authenticator app or a recovery code.')}</p>
          <Input label={L('인증 코드', 'Code')} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          <button className="btn primary" disabled={busy}>
            {L('확인', 'Verify')}
          </button>
          <ErrorText error={err} />
        </form>
      ) : recovery ? (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await authCall('password/forgot', { email });
              setInfo(L('계정이 존재하면 재설정 링크를 이메일로 보냈습니다.', 'If the account exists, we sent a reset link.'));
            });
          }}
        >
          <h2>{L('비밀번호 찾기', 'Account recovery')}</h2>
          <Input label={L('이메일', 'Email')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className="btn primary" disabled={busy}>
            {L('재설정 링크 보내기', 'Send reset link')}
          </button>
          {info && <Alert tone="ok">{info}</Alert>}
          <ErrorText error={err} />
          <button type="button" className="btn ghost" onClick={() => setRecovery(false)}>
            ← {L('로그인으로', 'Back to login')}
          </button>
        </form>
      ) : (
        <>
          <Tabs
            label={L('로그인 방식', 'Method')}
            value={mode}
            onChange={setMode}
            tabs={[
              { value: 'email', label: L('이메일', 'Email') },
              { value: 'otp', label: L('일회용 코드(OTP)', 'One-time code') },
            ]}
          />
          {mode === 'email' ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const j = await authCall('login', { email, password });
                  const mfaToken = j?.mfaToken ?? j?.challengeToken ?? j?.item?.mfaToken;
                  if ((j?.mfaRequired || mfaToken) && !extractAccessToken(j)) {
                    setMfa({ token: mfaToken ?? '' });
                    return;
                  }
                  router.replace(next);
                });
              }}
            >
              <Input label={L('이메일', 'Email')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <Input label={L('비밀번호', 'Password')} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              <button className="btn primary block" disabled={busy}>
                {busy ? L('로그인 중…', 'Signing in…') : L('로그인', 'Log in')}
              </button>
              <ErrorText error={err} />
              <button type="button" className="btn ghost sm" onClick={() => setRecovery(true)}>
                {L('비밀번호를 잊으셨나요?', 'Forgot password?')}
              </button>
            </form>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const channel = dest.includes('@') ? 'EMAIL' : 'SMS';
                  if (!otpSent) {
                    const j = await authCall('otp/start', { channel, destination: dest, [channel === 'EMAIL' ? 'email' : 'phone']: dest });
                    setOtpSent({ challengeId: j?.challengeId ?? j?.item?.challengeId ?? j?.id });
                    return;
                  }
                  await authCall('otp/verify', { channel, destination: dest, code, challengeId: otpSent.challengeId });
                  router.replace(next);
                });
              }}
            >
              <Input label={L('이메일 또는 휴대폰 번호', 'Email or phone')} value={dest} onChange={(e) => setDest(e.target.value)} required autoComplete="username" placeholder="010-1234-5678" disabled={!!otpSent} />
              {otpSent && <Input label={L('받은 코드', 'Code')} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />}
              <button className="btn primary block" disabled={busy}>
                {otpSent ? L('코드 확인', 'Verify code') : L('코드 받기', 'Send code')}
              </button>
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
