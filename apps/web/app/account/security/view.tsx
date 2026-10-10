'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { arr, item, items, str, f } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { startOAuth } from '@/components/auth/social';
import { Alert, Badge, Button, Checkbox, ErrorText, Icon, Input, PageHeader, Section, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { StateView, EmptyState } from '@/components/states';
import { CopyButton, QrCode, downloadText, styles as s } from '@/components/traveler/ui';
import { aalLabel, parseUserAgent, relTime } from '@/components/traveler/labels';
import { pickPair } from '@/lib/phrases';

const chunk = (v: string, n = 4) => (v.replace(/\s+/g, '').match(new RegExp(`.{1,${n}}`, 'g')) ?? []);

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { L } = useI18n();
  const [saved, setSaved] = useState(false);
  const text = `JETPOOL ${L('복구 코드', 'recovery codes')} (${new Date().toISOString().slice(0, 10)})\n${L('각 코드는 한 번만 사용할 수 있어요.', 'Each code works once.')}\n\n${codes.join('\n')}\n`;
  return (
    <div className="card stack" style={{ borderColor: 'color-mix(in srgb, var(--success) 40%, var(--border))' }}>
      <Alert tone="ok">
        <strong>{L('2단계 인증이 켜졌어요.', 'Two-step verification is on.')}</strong> {L('휴대폰을 잃어버렸을 때 쓸 복구 코드를 지금 저장하세요. 이 화면을 닫으면 다시 볼 수 없어요.', 'Save these recovery codes for when you lose your phone. They won’t be shown again.')}
      </Alert>
      <ul className={s.codes} aria-label={L('복구 코드', 'Recovery codes')}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="row" style={{ gap: 8 }}>
        <CopyButton text={codes.join('\n')} label={L('모두 복사', 'Copy all')} copied={L('복구 코드를 복사했어요', 'Codes copied')} />
        <Button size="sm" icon="download" onClick={() => downloadText('jetpool-recovery-codes.txt', text)}>
          {L('.txt 다운로드', 'Download .txt')}
        </Button>
      </div>
      <Checkbox label={L('복구 코드를 안전한 곳에 저장했어요', 'I saved my recovery codes somewhere safe')} checked={saved} onChange={(e) => setSaved(e.target.checked)} />
      <div className="row">
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {L('완료', 'Done')}
        </Button>
      </div>
    </div>
  );
}

function MfaSetup() {
  const { L, lang } = useI18n();
  const { authCall, user, reloadMe } = useAuth();
  const [setup, setSetup] = useState<{ factorId: string; secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
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
    <Section title={L('2단계 인증', 'Two-step verification')}>
      <div className="card stack">
        <div className="row between" style={{ gap: 12 }}>
          <div className="row nowrap" style={{ gap: 12 }}>
            <span className={s.sessionIco} style={{ background: user?.mfaEnabled ? 'var(--success-soft)' : 'var(--warn-soft)', color: user?.mfaEnabled ? 'var(--success)' : 'var(--warn)' }} aria-hidden="true">
              <Icon name="shield" size={20} />
            </span>
            <div>
              <strong>{L('인증 앱 (OTP)', 'Authenticator app (OTP)')}</strong>{' '}
              {user?.mfaEnabled ? <Badge tone="ok">{L('사용 중', 'On')}</Badge> : <Badge tone="warn">{L('꺼짐', 'Off')}</Badge>}
              <div className="xs muted">
                {L('이 기기의 로그인 보안', 'This session')}: {aalLabel(user?.aal, lang)}
              </div>
            </div>
          </div>
          {!setup && codes.length === 0 && (
            <Button
              variant={user?.mfaEnabled ? 'default' : 'primary'}
              loading={busy}
              onClick={() =>
                run(async () => {
                  const j = await authCall('mfa/totp/enroll', {});
                  const x = item(j) ?? j;
                  setSetup({ factorId: str(x, 'factorId', 'id'), secret: str(x, 'secret', 'base32'), uri: str(x, 'otpauthUrl', 'otpauthUri', 'uri') });
                })
              }
            >
              {user?.mfaEnabled ? L('인증 앱 다시 등록', 'Re-enroll authenticator') : L('2단계 인증 켜기', 'Turn on')}
            </Button>
          )}
        </div>
        <p className="small muted" style={{ margin: 0 }}>{L('로그인할 때 비밀번호와 함께 인증 앱의 6자리 코드를 입력해요. 관리자·정산·지원 업무는 2단계 인증을 마친 세션에서만 할 수 있어요.', 'Sign in with your password plus a 6-digit code from your app. Staff tools require a two-step verified session.')}</p>
        {user?.mfaEnabled && user.aal !== 'aal2' && !setup && codes.length === 0 && <StepUp />}
        {setup && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const j = await authCall('mfa/totp/verify', { factorId: setup.factorId, code });
                setCodes(arr(item(j) ?? j, 'recoveryCodes', 'backupCodes').map(String));
                setSetup(null);
                setCode('');
                await reloadMe();
              });
            }}
          >
            <hr style={{ margin: '4px 0' }} />
            <ol className={s.steps}>
              <li>
                <strong>{L('인증 앱을 여세요', 'Open your authenticator app')}</strong>
                <div className="small muted">{L('Google Authenticator, Microsoft Authenticator, 1Password 등', 'Google Authenticator, Microsoft Authenticator, 1Password…')}</div>
              </li>
              <li>
                <strong>{L('QR 코드를 스캔하세요', 'Scan the QR code')}</strong>
                <div className={s.qrWrap} style={{ marginTop: 10 }}>
                  {setup.uri ? <QrCode text={setup.uri} label={L('2단계 인증 등록용 QR 코드', 'QR code for two-step setup')} /> : null}
                  <div className="stack" style={{ margin: 0 }}>
                    <span className="small muted">{L('스캔할 수 없다면 아래 키를 앱에 직접 입력하세요.', 'Can’t scan? Enter this key in the app.')}</span>
                    <div className={s.secret} aria-label={L(`설정 키 ${setup.secret}`, `Setup key ${setup.secret}`)}>
                      {chunk(setup.secret).map((g, i) => (
                        <span key={i} aria-hidden="true">
                          {g}
                        </span>
                      ))}
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <CopyButton text={setup.secret} label={L('키 복사', 'Copy key')} copied={L('설정 키를 복사했어요', 'Key copied')} />
                      {setup.uri && (
                        <a href={setup.uri} className="btn sm ghost">
                          <Icon name="external" size={16} /> {L('이 기기의 인증 앱으로 열기', 'Open in an app on this device')}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </li>
              <li>
                <strong>{L('앱에 표시된 6자리 코드를 입력하세요', 'Enter the 6-digit code')}</strong>
                <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
                  <div style={{ maxWidth: 200 }}>
                    <Input label={L('인증 코드', 'Code')} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required placeholder="123456" style={{ letterSpacing: '0.3em', fontWeight: 700 }} />
                  </div>
                  <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
                    {L('확인하고 켜기', 'Verify & turn on')}
                  </Button>
                  <Button variant="ghost" onClick={() => setSetup(null)}>
                    {L('취소', 'Cancel')}
                  </Button>
                </div>
              </li>
            </ol>
          </form>
        )}
        {codes.length > 0 && <RecoveryCodes codes={codes} onDone={() => setCodes([])} />}
        <ErrorText error={err} />
      </div>
    </Section>
  );
}

function StepUp() {
  const { L } = useI18n();
  const { authCall } = useAuth();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await authCall('mfa/challenge', /^\d{6}$/.test(code) ? { code } : { recoveryCode: code });
          toast.show(L('이 기기를 2단계 인증 세션으로 전환했어요', 'This session is now two-step verified'));
          setCode('');
        } catch (x) {
          setErr(x);
        }
      }}
    >
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ maxWidth: 220 }}>
          <Input label={L('인증 코드 또는 복구 코드', 'Code or recovery code')} inputMode="numeric" autoComplete="one-time-code" maxLength={32} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <Button type="submit" disabled={!code.trim()}>
          {L('이 기기 2단계 인증하기', 'Verify this session')}
        </Button>
      </div>
      <ErrorText error={err} />
    </form>
  );
}

function PasswordChange() {
  const { L } = useI18n();
  const { authCall } = useAuth();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={L('비밀번호 변경', 'Change password')}>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setBusy(true);
          try {
            await authCall('password/change', { currentPassword: cur, newPassword: next });
            toast.show(L('비밀번호를 바꿨어요. 다른 기기에서는 로그아웃됐어요.', 'Password changed. Other devices were signed out.'));
            setCur('');
            setNext('');
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid cols-2">
          <Input label={L('현재 비밀번호', 'Current password')} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          <Input label={L('새 비밀번호', 'New password')} type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required hint={L('10자 이상, 다른 사이트와 다른 비밀번호를 쓰세요.', 'At least 10 characters; don’t reuse passwords.')} />
        </div>
        <div className="row">
          <Button type="submit" variant="primary" loading={busy} disabled={!cur || next.length < 10}>
            {L('비밀번호 변경', 'Change password')}
          </Button>
        </div>
        <ErrorText error={err} />
      </form>
    </Section>
  );
}

const PROVIDERS: Array<[string, string, string]> = [
  ['google', 'Google', 'Google'],
  ['kakao', '카카오', 'Kakao'],
  ['naver', '네이버', 'Naver'],
];

function LinkedAccounts() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const toast = useToast();
  const st = useApi<any>('/v1/me/identities', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const linked = new Set(items(st.data).map((i: any) => str(i, 'provider').toLowerCase()));
  return (
    <Section title={L('연결된 소셜 계정', 'Linked accounts')}>
      {sp.get('link') && <Alert tone="info">{L('같은 이메일로 가입된 계정이 있어요. 기존 방법으로 로그인한 뒤 아래에서 연결하세요.', 'An account with this email exists. Sign in the usual way, then link below.')}</Alert>}
      {sp.get('linked') && <Alert tone="ok">{L('소셜 계정을 연결했어요.', 'Account linked.')}</Alert>}
      <ul className={s.sessions}>
        {PROVIDERS.map(([p, ko, en]) => (
          <li key={p} className={s.session}>
            <span className={s.sessionIco} aria-hidden="true">
              <Icon name="globe" size={20} />
            </span>
            <div>
              <strong>{lang === 'ko' ? ko : en}</strong>
              <div className={s.meta}>{linked.has(p) ? L('이 계정으로 로그인할 수 있어요', 'You can sign in with this account') : L('연결하면 간편하게 로그인할 수 있어요', 'Link for one-tap sign-in')}</div>
            </div>
            {linked.has(p) ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  setErr(null);
                  try {
                    await api(`/v1/me/identities/${p}`, { method: 'DELETE' });
                    toast.show(L('연결을 해제했어요', 'Unlinked'));
                    st.reload();
                  } catch (e) {
                    setErr(e);
                  }
                }}
              >
                {L('연결 해제', 'Unlink')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={async () => {
                  setErr(null);
                  try {
                    await startOAuth(p, { link: true, returnTo: '/account/security?linked=1' });
                  } catch (e) {
                    setErr(e);
                  }
                }}
              >
                {L('연결하기', 'Link')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ErrorText error={err} />
    </Section>
  );
}

const METHOD: Record<string, [string, string]> = { PASSWORD: ['비밀번호', 'Password'], OAUTH: ['소셜 로그인', 'Social sign-in'], GOOGLE: ['Google', 'Google'], KAKAO: ['카카오', 'Kakao'], NAVER: ['네이버', 'Naver'], EMAIL_OTP: ['이메일 코드', 'Email code'], OTP: ['인증 코드', 'One-time code'] };

function Sessions() {
  const { L, lang } = useI18n();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const st = useApi<any>('/v1/auth/sessions', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [all, setAll] = useState(false);
  const rows = [...items(st.data)].sort((a: any, b: any) => (f(b, 'current') === true ? 1 : 0) - (f(a, 'current') === true ? 1 : 0) || str(b, 'lastUsedAt', 'last_used_at').localeCompare(str(a, 'lastUsedAt', 'last_used_at')));
  const others = rows.filter((x: any) => f(x, 'current') !== true);
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <Section
      title={L('로그인된 기기', 'Where you’re signed in')}
      actions={
        others.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            icon="logout"
            onClick={async () => {
              const r = await confirm({
                title: L('다른 기기에서 모두 로그아웃할까요?', 'Sign out of all other devices?'),
                body: L(`이 기기를 제외한 ${others.length}개 기기에서 로그아웃돼요. 모르는 기기가 있다면 비밀번호도 바꿔 주세요.`, `${others.length} other session(s) will be signed out. Change your password if you see a device you don’t recognize.`),
                tone: 'danger',
                confirmLabel: L('모두 로그아웃', 'Sign out all'),
                run: async () => {
                  await Promise.all(others.map((x: any) => api(`/v1/auth/sessions/${str(x, 'id')}`, { method: 'DELETE' }).catch(() => null)));
                },
              });
              if (r.ok) {
                toast.show(L('다른 기기에서 로그아웃했어요', 'Signed out of other devices'));
                st.reload();
              }
            }}
          >
            {L('다른 기기에서 모두 로그아웃', 'Sign out other devices')}
          </Button>
        ) : undefined
      }
    >
      {dialog}
      <ErrorText error={err} />
      <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState title={L('로그인 기록을 불러올 수 없어요', 'No session info')} />}>
        {() => (
          <>
            <ul className={s.sessions}>
              {shown.map((x: any) => {
                const ua = parseUserAgent(str(x, 'userAgent', 'user_agent', 'device'));
                const current = f(x, 'current') === true;
                const method = str(x, 'authMethod', 'auth_method').toUpperCase();
                return (
                  <li key={str(x, 'id')} className={s.session}>
                    <span className={s.sessionIco} aria-hidden="true">
                      <Icon name={ua.mobile ? 'phone' : 'laptop'} size={20} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <strong>
                        {ua.label || L('알 수 없는 기기', 'Unknown device')}
                        {current && <Badge tone="info">{L('현재 기기', 'This device')}</Badge>}
                      </strong>
                      <div className={s.meta}>
                        {[current ? L('지금 사용 중', 'Active now') : `${L('최근 활동', 'Last active')} ${relTime(str(x, 'lastUsedAt', 'last_used_at', 'createdAt', 'created_at'), lang)}`, str(x, 'ip') && `IP ${str(x, 'ip')}`, pickPair(METHOD[method], lang), aalLabel(str(x, 'aal'), lang)].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {current ? (
                      <span className="xs muted">{L('이 기기', 'This device')}</span>
                    ) : (
                      <Button
                        size="sm"
                        onClick={async () => {
                          setErr(null);
                          try {
                            await api(`/v1/auth/sessions/${str(x, 'id')}`, { method: 'DELETE' });
                            toast.show(L('해당 기기에서 로그아웃했어요', 'Signed out of that device'));
                            st.reload();
                          } catch (e) {
                            setErr(e);
                          }
                        }}
                      >
                        {L('로그아웃', 'Sign out')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {rows.length > 5 && (
              <div className="row">
                <Button size="sm" variant="ghost" icon={all ? 'minus' : 'down'} aria-expanded={all} onClick={() => setAll((v) => !v)}>
                  {all ? L('접기', 'Show less') : L(`${rows.length - 5}개 더 보기`, `Show ${rows.length - 5} more`)}
                </Button>
              </div>
            )}
          </>
        )}
      </StateView>
    </Section>
  );
}

export default function SecurityView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('보안 · 로그인', 'Security & sign-in')} subtitle={L('2단계 인증, 비밀번호, 로그인된 기기를 관리하세요.', 'Manage two-step verification, your password and signed-in devices.')} />
      <MfaSetup />
      <PasswordChange />
      <LinkedAccounts />
      <Sessions />
    </RequireAuth>
  );
}
