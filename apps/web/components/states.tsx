'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { Spinner, ErrorText } from './ui';

export function LoginLink({ children }: { children?: ReactNode }) {
  const path = usePathname();
  const { t } = useI18n();
  return (
    <Link className="btn primary" href={`/login?next=${encodeURIComponent(path || '/')}`}>
      {children ?? t('nav.login')}
    </Link>
  );
}

/** Step-up prompt shown on 403 AAL2_REQUIRED: verifies a TOTP code via the BFF (new AAL2 tokens). */
export function MfaPrompt({ onDone }: { onDone?: () => void }) {
  const { t, L } = useI18n();
  const { authCall, user } = useAuth();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="state" role="alert">
      <h2>🔐 {L('MFA 인증 필요', 'MFA required')}</h2>
      <p>{t('state.mfa')}</p>
      {user?.mfaEnabled === false && (
        <p>
          <Link href="/account/security">{L('먼저 계정 보안에서 MFA(OTP 앱)를 등록하세요.', 'Set up an authenticator in Account security first.')}</Link>
        </p>
      )}
      <form
        className="row"
        style={{ justifyContent: 'center', maxWidth: 420, margin: '12px auto 0' }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await authCall('mfa/verify', { code });
            onDone?.();
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="sr-only" htmlFor="mfa-code">
          {L('인증 코드', 'Code')}
        </label>
        <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} required />
        <button className="btn primary" disabled={busy}>
          {t('state.mfa.cta')}
        </button>
      </form>
      <div style={{ marginTop: 12 }}>
        <ErrorText error={err} />
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, lang, L } = useI18n();
  const kind = error instanceof ApiError ? error.kind : 'server';
  if (kind === 'unauthenticated')
    return (
      <div className="state" role="alert">
        <h2>{t('state.unauth')}</h2>
        <LoginLink />
      </div>
    );
  if (kind === 'mfa_required') return <MfaPrompt onDone={onRetry} />;
  if (kind === 'forbidden')
    return (
      <div className="state" role="alert">
        <h2>403 · {t('state.forbidden')}</h2>
        <p className="muted">{errorMessage(error, lang)}</p>
        <Link href="/">{L('홈으로', 'Go home')}</Link>
      </div>
    );
  if (kind === 'disabled')
    return (
      <div className="state" role="status">
        <h2>{t('state.disabled')}</h2>
        <p className="muted">{L('법률·사업 검토(G9) 완료 후 순차적으로 오픈됩니다.', 'It will open after legal/business review (G9).')}</p>
      </div>
    );
  if (kind === 'not_found')
    return (
      <div className="state" role="alert">
        <h2>404 · {t('state.notfound')}</h2>
        <Link href="/">{L('홈으로', 'Go home')}</Link>
      </div>
    );
  return (
    <div className="state" role="alert">
      <h2>{t('state.error')}</h2>
      <p className="muted">{errorMessage(error, lang)}</p>
      {error instanceof ApiError && error.problem.correlationId && <p className="mono small">ref: {error.problem.correlationId}</p>}
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          {t('state.retry')}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="state" role="status">
      <h2>{title ?? t('state.empty')}</h2>
      {children}
    </div>
  );
}

/**
 * Standard loading / error / empty / permission wrapper (DoD: every UI route has these states).
 */
export function StateView<T>({
  state,
  isEmpty,
  empty,
  children,
}: {
  state: { data: T | undefined; error: unknown; loading: boolean; reload?: () => void };
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (d: T) => ReactNode;
}) {
  if (state.loading && state.data === undefined) return <Spinner />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return <Spinner />;
  if (isEmpty && isEmpty(state.data)) return <>{empty ?? <EmptyState />}</>;
  return <>{children(state.data)}</>;
}

export { ErrorText };
