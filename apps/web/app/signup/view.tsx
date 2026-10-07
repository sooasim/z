'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { ErrorText, Input, Checkbox, Alert } from '@/components/ui';
import { SocialButtons, safeNext } from '@/components/auth/social';

export default function SignupView() {
  const { L, lang } = useI18n();
  const { authCall } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [age, setAge] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack-lg">
      <h1>{L('회원가입', 'Create account')}</h1>
      {verifySent ? (
        <Alert tone="ok">{L('가입 완료! 이메일 인증 링크를 확인해 주세요.', 'Account created! Check your email to verify.')}</Alert>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const j = await authCall('signup', {
                ...form,
                locale: lang === 'ko' ? 'ko-KR' : 'en-US',
                consents: [
                  { type: 'TERMS', granted: terms },
                  { type: 'PRIVACY', granted: privacy },
                  { type: 'AGE_14', granted: age },
                  { type: 'MARKETING', granted: marketing },
                ],
              });
              if (j?.accessToken || j?.item?.accessToken) router.replace(next);
              else setVerifySent(true);
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input label={L('이름(표시명)', 'Display name')} value={form.displayName} onChange={set('displayName')} required autoComplete="nickname" maxLength={40} />
          <Input label={L('이메일', 'Email')} type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
          <Input label={L('비밀번호', 'Password')} type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" hint={L('10자 이상, 다른 사이트와 다른 비밀번호', '10+ chars, unique to JETPOOL')} />
          <fieldset className="stack">
            <legend>{L('약관 동의', 'Agreements')}</legend>
            <Checkbox label={<>{L('[필수] 이용약관 동의', '[Required] Terms of service')}</>} checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
            <Checkbox label={L('[필수] 개인정보 수집·이용 동의', '[Required] Privacy policy')} checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} required />
            <Checkbox label={L('[필수] 만 14세 이상입니다', '[Required] I am 14 or older')} checked={age} onChange={(e) => setAge(e.target.checked)} required />
            <Checkbox label={L('[선택] 마케팅 정보 수신 동의', '[Optional] Marketing messages')} checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          </fieldset>
          <button className="btn primary block" disabled={busy || !terms || !privacy || !age}>
            {busy ? L('가입 중…', 'Creating…') : L('가입하기', 'Sign up')}
          </button>
          <ErrorText error={err} />
        </form>
      )}
      <SocialButtons next={next} />
      <p className="center">
        {L('이미 계정이 있나요?', 'Have an account?')} <Link href={`/login?next=${encodeURIComponent(next)}`}>{L('로그인', 'Log in')}</Link>
      </p>
    </div>
  );
}
