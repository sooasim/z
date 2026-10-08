'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { useApi } from '@/lib/hooks';
import { items, str } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { fieldErrors } from '@/lib/errors';
import { Alert, Button, ErrorText, Input, Modal } from '@/components/ui';
import { SocialButtons, safeNext } from '@/components/auth/social';
import { Markdown } from '@/components/public/Markdown';
import s from '@/components/public/public.module.css';

type ConsentKey = 'terms' | 'privacy' | 'age' | 'marketing';
const DOC_TYPE: Partial<Record<ConsentKey, string>> = { terms: 'TERMS', privacy: 'PRIVACY', marketing: 'MARKETING' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignupView() {
  const { L, lang } = useI18n();
  const { authCall } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [agree, setAgree] = useState<Record<ConsentKey, boolean>>({ terms: false, privacy: false, age: false, marketing: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [doc, setDoc] = useState<ConsentKey | null>(null);
  // Current consent document versions are required by the API (consent evidence is versioned).
  const docs = useApi<any>('/v1/consent-documents');
  const docOf = (t: string) => items(docs.data).find((d: any) => str(d, 'type') === t);
  const version = (t: string) => str(docOf(t), 'version') || '1';
  const consents = useMemo(
    () => [
      { type: 'TERMS', version: version('TERMS'), granted: agree.terms },
      { type: 'PRIVACY', version: version('PRIVACY'), granted: agree.privacy },
      { type: 'MARKETING', version: version('MARKETING'), granted: agree.marketing },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs.data, agree],
  );
  const required = agree.terms && agree.privacy && agree.age;
  const all = required && agree.marketing;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    if (errors[k]) setErrors((x) => ({ ...x, [k]: '' }));
  };
  const toggle = (k: ConsentKey, v: boolean) => {
    setAgree((a) => ({ ...a, [k]: v }));
    if (v) setErrors((x) => ({ ...x, consents: '' }));
  };
  const items4: Array<{ k: ConsentKey; label: string; req: boolean }> = [
    { k: 'terms', label: L('[필수] 이용약관 동의', '[Required] Terms of service'), req: true },
    { k: 'privacy', label: L('[필수] 개인정보 수집·이용 동의', '[Required] Privacy policy'), req: true },
    { k: 'age', label: L('[필수] 만 14세 이상입니다', '[Required] I am 14 or older'), req: true },
    { k: 'marketing', label: L('[선택] 혜택·이벤트 소식 받기 (이메일·앱 알림)', '[Optional] Offers and news (email & push)'), req: false },
  ];
  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.displayName.trim()) e.displayName = L('이름(표시명)을 입력해 주세요.', 'Enter a display name.');
    if (!form.email.trim()) e.email = L('이메일을 입력해 주세요.', 'Enter your email.');
    else if (!EMAIL_RE.test(form.email.trim())) e.email = L('이메일 형식이 올바르지 않아요. 예: name@example.com', 'Check the email format, e.g. name@example.com');
    if (!form.password) e.password = L('비밀번호를 입력해 주세요.', 'Enter a password.');
    else if (form.password.length < 10 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) e.password = L('10자 이상, 영문과 숫자를 함께 사용해 주세요.', 'Use at least 10 characters with letters and numbers.');
    if (!required) e.consents = L('필수 약관에 모두 동의해 주세요.', 'Please accept all required terms.');
    return e;
  };
  const focusFirst = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  const serverErrs = fieldErrors(err, lang);
  const errOf = (k: string) => errors[k] || serverErrs[k] || '';
  const errHint = (k: string, hint?: string) => (errOf(k) ? <span className={s.err}>{errOf(k)}</span> : hint);
  const shown = doc ? docOf(DOC_TYPE[doc] ?? '') : null;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>{L('회원가입', 'Create account')}</h1>
        <p className="muted" style={{ margin: 0 }}>{L('숙소 예약, 홈 맞교환, 가이드 프렌드를 하나의 계정으로.', 'One account for stays, home exchange and guide friends.')}</p>
      </div>
      {verifySent ? (
        <Alert tone="ok">{L('가입 완료! 이메일 인증 링크를 확인해 주세요.', 'Account created! Check your email to verify.')}</Alert>
      ) : (
        <form
          ref={formRef}
          className="stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const v = validate();
            setErrors(v);
            if (Object.values(v).some(Boolean)) {
              focusFirst();
              return;
            }
            setBusy(true);
            setErr(null);
            try {
              const j = await authCall('signup', { ...form, email: form.email.trim(), locale: lang === 'ko' ? 'ko-KR' : 'en-US', consents });
              if (j?.accessToken || j?.item?.accessToken) router.replace(next);
              else setVerifySent(true);
            } catch (x) {
              setErr(x);
              if (Object.keys(fieldErrors(x, lang)).length) focusFirst();
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input label={L('이름(표시명)', 'Display name')} value={form.displayName} onChange={set('displayName')} required autoComplete="nickname" maxLength={40} aria-invalid={errOf('displayName') ? true : undefined} hint={errHint('displayName', L('후기와 메시지에 표시돼요.', 'Shown on reviews and messages.'))} />
          <Input label={L('이메일', 'Email')} type="email" inputMode="email" value={form.email} onChange={set('email')} required autoComplete="email" aria-invalid={errOf('email') ? true : undefined} hint={errHint('email')} />
          <Input label={L('비밀번호', 'Password')} type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" aria-invalid={errOf('password') ? true : undefined} hint={errHint('password', L('10자 이상, 영문과 숫자를 함께 · 다른 사이트와 다른 비밀번호', '10+ characters with letters and numbers, unique to JETPOOL'))} />
          <fieldset className="stack" aria-describedby={errors.consents ? 'consent-e' : undefined}>
            <legend>{L('약관 동의', 'Agreements')}</legend>
            <label className={`check ${s.consentAll}`}>
              <input
                type="checkbox"
                checked={all}
                aria-invalid={errors.consents ? true : undefined}
                ref={(el) => {
                  if (el) el.indeterminate = !all && (agree.terms || agree.privacy || agree.age || agree.marketing);
                }}
                onChange={(e) => {
                  const v = e.target.checked;
                  setAgree({ terms: v, privacy: v, age: v, marketing: v });
                  if (v) setErrors((x) => ({ ...x, consents: '' }));
                }}
              />
              <span>
                {L('모두 동의합니다', 'Agree to all')}
                <span className="xs muted" style={{ display: 'block', fontWeight: 400 }}>{L('필수 및 선택(혜택 소식) 항목에 모두 동의해요. 선택 항목은 동의하지 않아도 가입할 수 있어요.', 'Includes the optional offers. You can sign up without the optional item.')}</span>
              </span>
            </label>
            {items4.map((it) => (
              <div key={it.k} className={s.consentRow}>
                <label className="check">
                  <input type="checkbox" checked={agree[it.k]} onChange={(e) => toggle(it.k, e.target.checked)} aria-invalid={it.req && errors.consents && !agree[it.k] ? true : undefined} />
                  <span>{it.label}</span>
                </label>
                {DOC_TYPE[it.k] && (
                  <button type="button" className="btn link sm" onClick={() => setDoc(it.k)} aria-label={L(`${it.label} 내용 보기`, `Read: ${it.label}`)}>
                    {L('보기', 'View')}
                  </button>
                )}
              </div>
            ))}
            {errors.consents && (
              <small id="consent-e" className={`xs ${s.err}`} role="alert">
                {errors.consents}
              </small>
            )}
          </fieldset>
          <Button type="submit" variant="primary" block loading={busy}>
            {busy ? L('가입 중…', 'Creating…') : L('가입하기', 'Sign up')}
          </Button>
          <ErrorText error={err} />
        </form>
      )}
      <div className="row" style={{ gap: 8 }}>
        <hr className="grow" />
        <span className="muted small">{L('또는', 'or')}</span>
        <hr className="grow" />
      </div>
      <p className="xs muted center" style={{ margin: 0 }}>{L('소셜 가입도 위 필수 약관 동의가 필요해요.', 'Social sign-up also requires the agreements above.')}</p>
      <SocialButtons next={next} consents={consents} disabled={!required} />
      <p className="center">
        {L('이미 계정이 있나요?', 'Have an account?')} <Link href={`/login?next=${encodeURIComponent(next)}`}>{L('로그인', 'Log in')}</Link>
      </p>
      <Modal
        open={doc !== null}
        onClose={() => setDoc(null)}
        title={(str(shown, 'title') || (doc ? items4.find((x) => x.k === doc)?.label ?? '' : '')).replace(/\s*\((초안|draft)\)\s*/gi, '').replace(/^\[(필수|선택|Required|Optional)\]\s*/, '')}
        footer={
          doc ? (
            <>
              <button type="button" className="btn ghost" onClick={() => setDoc(null)}>
                {L('닫기', 'Close')}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  toggle(doc, true);
                  setDoc(null);
                }}
              >
                {L('동의하고 닫기', 'Agree & close')}
              </button>
            </>
          ) : undefined
        }
      >
        {docs.loading ? (
          <p className="muted">{L('불러오는 중…', 'Loading…')}</p>
        ) : shown ? (
          <Markdown source={str(shown, 'bodyMd', 'body')} compact baseLevel={3} />
        ) : (
          <p className="muted">{L('문서를 불러오지 못했어요. 고객센터에서 전문을 확인할 수 있어요.', 'We couldn’t load the document. The full text is available from the help centre.')}</p>
        )}
      </Modal>
    </div>
  );
}
