'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { arr, item, items, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { startOAuth } from '@/components/auth/social';
import { errorMessage } from '@/lib/errors';
import { Alert, DateText, ErrorText, Input, PageHeader, Section, StatusBadge } from '@/components/ui';
import { StateView, EmptyState } from '@/components/states';

function MfaSetup() {
  const { L } = useI18n();
  const { authCall, user, reloadMe } = useAuth();
  const [setup, setSetup] = useState<{ factorId: string; secret: string; uri: string; qr?: string } | null>(null);
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
    <Section title={L('2단계 인증 (TOTP)', 'Two-factor authentication (TOTP)')}>
      <div className="card stack">
        <p>
          {L('상태', 'Status')}: {user?.mfaEnabled ? <span className="badge ok">{L('사용 중', 'Enabled')}</span> : <span className="badge warn">{L('미설정', 'Not set up')}</span>}{' '}
          · {L('현재 세션', 'This session')}: <strong>{user?.aal === 'aal2' ? 'AAL2' : 'AAL1'}</strong>
        </p>
        <p className="small muted">{L('관리자·정산·지원 역할은 MFA 세션(AAL2)에서만 작업할 수 있습니다.', 'Staff roles can act only in AAL2 (MFA) sessions.')}</p>
        {!setup && codes.length === 0 && (
          <div className="row">
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const j = await authCall('mfa/totp/enroll', {});
                  const s = item(j) ?? j;
                  setSetup({ factorId: str(s, 'factorId', 'id'), secret: str(s, 'secret', 'base32'), uri: str(s, 'otpauthUrl', 'otpauthUri', 'uri'), qr: str(s, 'qrDataUrl', 'qrCode', 'qr') });
                })
              }
            >
              {user?.mfaEnabled ? L('인증 앱 재등록', 'Re-enroll authenticator') : L('MFA 설정 시작', 'Set up MFA')}
            </button>
            {user?.mfaEnabled && user.aal !== 'aal2' && <StepUp />}
          </div>
        )}
        {setup && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const j = await authCall('mfa/totp/verify', { factorId: setup.factorId, code });
                setCodes(arr(item(j) ?? j, 'recoveryCodes', 'backupCodes').map(String));
                setSetup(null);
                await reloadMe();
              });
            }}
          >
            <ol>
              <li>{L('Google Authenticator, 1Password 등 인증 앱을 엽니다.', 'Open an authenticator app.')}</li>
              <li>
                {L('QR을 스캔하거나 아래 키를 직접 입력합니다.', 'Scan the QR or enter the key manually.')}
                {setup.qr && setup.qr.startsWith('data:image') && <img src={setup.qr} alt={L('MFA 등록 QR 코드', 'MFA QR code')} width={180} height={180} style={{ margin: '8px 0' }} />}
                <p className="mono" aria-label={L('비밀 키', 'Secret key')}>{setup.secret}</p>
                {setup.uri && (
                  <a href={setup.uri} className="small">
                    {L('이 기기의 인증 앱으로 열기', 'Open in authenticator on this device')}
                  </a>
                )}
              </li>
              <li>{L('앱에 표시된 6자리 코드를 입력합니다.', 'Enter the 6-digit code.')}</li>
            </ol>
            <Input label={L('인증 코드', 'Code')} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
            <button className="btn primary" disabled={busy}>
              {L('활성화', 'Enable')}
            </button>
          </form>
        )}
        {codes.length > 0 && (
          <Alert tone="ok">
            <strong>{L('복구 코드를 안전한 곳에 보관하세요. 다시 표시되지 않습니다.', 'Save these recovery codes. They will not be shown again.')}</strong>
            <ul className="mono">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Alert>
        )}
        <ErrorText error={err} />
      </div>
    </Section>
  );
}

function StepUp() {
  const { L } = useI18n();
  const { authCall } = useAuth();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await authCall('mfa/challenge', /^\d{6}$/.test(code) ? { code } : { recoveryCode: code });
        } catch (x) {
          setErr(x);
        }
      }}
    >
      <label className="sr-only" htmlFor="stepup">{L('인증 코드', 'Code')}</label>
      <input id="stepup" inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 140 }} />
      <button className="btn">{L('이 세션 AAL2로 승급', 'Step up this session')}</button>
      <ErrorText error={err} />
    </form>
  );
}

function PasswordChange() {
  const { L } = useI18n();
  const { authCall } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Section title={L('비밀번호 변경', 'Change password')}>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setOk(false);
          try {
            await authCall('password/change', { currentPassword: cur, newPassword: next });
            setOk(true);
            setCur('');
            setNext('');
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <div className="form-grid cols-2">
          <Input label={L('현재 비밀번호', 'Current password')} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          <Input label={L('새 비밀번호', 'New password')} type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div className="row">
          <button className="btn primary">{L('변경', 'Change')}</button>
          {ok && <span className="badge ok">✓ {L('변경됨 — 다른 세션은 로그아웃됩니다', 'Changed — other sessions signed out')}</span>}
        </div>
        <ErrorText error={err} />
      </form>
    </Section>
  );
}

function LinkedAccounts() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const st = useApi<any>('/v1/me/identities', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const linked = new Set(items(st.data).map((i: any) => str(i, 'provider').toLowerCase()));
  return (
    <Section title={L('연결된 소셜 계정', 'Linked accounts')}>
      {sp.get('link') && <Alert tone="info">{L('같은 이메일의 기존 계정이 있습니다. 기존 방법으로 로그인한 뒤 아래에서 연결하세요.', 'An account with this email exists. Sign in with your existing method, then link below.')}</Alert>}
      {sp.get('linked') && <Alert tone="ok">{L('소셜 계정을 연결했습니다.', 'Account linked.')}</Alert>}
      <div className="card stack">
        {['google', 'kakao', 'naver'].map((p) => (
          <div key={p} className="row between">
            <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{p}</span>
            {linked.has(p) ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="badge ok">{L('연결됨', 'Linked')}</span>
                <button className="btn sm ghost" onClick={async () => { setErr(null); try { await api(`/v1/me/identities/${p}`, { method: 'DELETE' }); st.reload(); } catch (e) { setErr(e); } }}>{L('해제', 'Unlink')}</button>
              </span>
            ) : (
              <button className="btn sm" onClick={async () => { setErr(null); try { await startOAuth(p, { link: true, returnTo: '/account/security?linked=1' }); } catch (e) { setErr(e); } }}>
                {L('연결하기', 'Link')}
              </button>
            )}
          </div>
        ))}
        {err ? <Alert tone="error">{errorMessage(err, lang)}</Alert> : null}
      </div>
    </Section>
  );
}

function Sessions() {
  const { L } = useI18n();
  const st = useApi<any>('/v1/auth/sessions', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Section title={L('로그인된 기기', 'Active sessions')}>
      <ErrorText error={err} />
      <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState title={L('세션 정보를 불러올 수 없습니다.', 'No session info.')} />}>
        {(d) => (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {items(d).map((s: any) => (
              <li key={str(s, 'id')} className="card flat row between">
                <div>
                  <strong>{str(s, 'userAgent', 'device') || L('알 수 없는 기기', 'Unknown device')}</strong>
                  <div className="small muted">
                    <DateText value={str(s, 'lastSeenAt', 'createdAt')} time /> · {str(s, 'aal').toUpperCase()} {str(s, 'current') === 'true' && <StatusBadge status="CURRENT" />}
                  </div>
                </div>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await api(`/v1/auth/sessions/${str(s, 'id')}`, { method: 'DELETE' });
                      st.reload();
                    } catch (e) {
                      setErr(e);
                    }
                  }}
                >
                  {L('로그아웃', 'Revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </StateView>
    </Section>
  );
}

export default function SecurityView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('계정 보안', 'Account security')} />
      <MfaSetup />
      <PasswordChange />
      <LinkedAccounts />
      <Sessions />
    </RequireAuth>
  );
}
