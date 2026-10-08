'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { ErrorText } from './ui/base';
import { Illustration, type IlloName } from './ui/illustrations';
import { CardGridSkeleton, DetailSkeleton, ListSkeleton, TableSkeleton } from './ui/skeleton';

type Heading = 'h1' | 'h2' | 'h3';

/** Heading for full-page states: use `as="h1"` when the state is the page's only content (no other <h1>). */
function StateHeading({ as = 'h2', children }: { as?: Heading; children: ReactNode }) {
  const H = as;
  return <H>{children}</H>;
}

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
export function MfaPrompt({ onDone, as }: { onDone?: () => void; as?: Heading }) {
  const { t, L } = useI18n();
  const { authCall, user } = useAuth();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="state" role="alert">
      <Illustration name="lock" />
      <StateHeading as={as}>{L('MFA 인증 필요', 'MFA required')}</StateHeading>
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
            await authCall('mfa/challenge', /^\d{6}$/.test(code) ? { code } : { recoveryCode: code });
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
        <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={32} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} required />
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

/** Contextual way back for not-found / forbidden states, e.g. `{ href: '/trips', label: '내 여행으로' }`. */
export interface StateLink {
  href: string;
  label: string;
}

/**
 * Standard error state. `as` sets the heading level; `action` replaces the default CTA (forbidden / not-found /
 * disabled); `back` adds a contextual link; `title` / `body` override the copy (e.g. per-feature "coming soon").
 */
export function ErrorState({ error, onRetry, as, action, back, title, body }: { error: unknown; onRetry?: () => void; as?: Heading; action?: ReactNode; back?: StateLink; title?: ReactNode; body?: ReactNode }) {
  const { t, lang, L } = useI18n();
  const kind = error instanceof ApiError ? error.kind : 'server';
  const backLink = back ? (
    <Link className="btn" href={back.href}>
      {back.label}
    </Link>
  ) : null;
  if (kind === 'unauthenticated')
    return (
      <div className="state" role="alert">
        <Illustration name="lock" />
        <StateHeading as={as}>{title ?? t('state.unauth')}</StateHeading>
        <p className="muted">{body ?? L('로그인하면 예약, 메시지, 저장 목록을 이용할 수 있어요.', 'Sign in to see trips, messages and saved places.')}</p>
        <div className="actions">{action ?? <LoginLink />}</div>
      </div>
    );
  if (kind === 'mfa_required') return <MfaPrompt onDone={onRetry} as={as} />;
  if (kind === 'forbidden')
    return (
      <div className="state" role="alert">
        <Illustration name="lock" />
        <StateHeading as={as}>{title ?? t('state.forbidden')}</StateHeading>
        <p className="muted">{body ?? errorMessage(error, lang)}</p>
        <div className="actions">
          {action ?? (
            <Link className="btn" href="/">
              {L('홈으로', 'Go home')}
            </Link>
          )}
          {backLink}
        </div>
      </div>
    );
  if (kind === 'disabled')
    return (
      <div className="state" role="status">
        <Illustration name="calendar" />
        <StateHeading as={as}>{title ?? t('state.disabled')}</StateHeading>
        <p className="muted">{body ?? L('준비가 끝나면 알림으로 알려드릴게요.', 'We’ll let you know as soon as it’s ready.')}</p>
        {(action || backLink) && (
          <div className="actions">
            {action}
            {backLink}
          </div>
        )}
      </div>
    );
  if (kind === 'not_found') return <NotFoundState as={as} back={back} action={action} title={title} body={body} />;
  return (
    <div className="state" role="alert">
      <Illustration name={kind === 'network' ? 'offline' : 'error'} />
      <StateHeading as={as}>{title ?? (kind === 'network' ? L('연결할 수 없습니다', 'Can’t connect') : t('state.error'))}</StateHeading>
      <p className="muted">{body ?? errorMessage(error, lang)}</p>
      {error instanceof ApiError && error.problem.correlationId && <p className="mono small subtle">ref: {error.problem.correlationId}</p>}
      {(onRetry || action || backLink) && (
        <div className="actions">
          {onRetry && (
            <button className="btn primary" onClick={onRetry}>
              {t('state.retry')}
            </button>
          )}
          {action}
          {backLink}
        </div>
      )}
    </div>
  );
}

/** Not-found state for entity pages: localized copy + a contextual way back (and home). */
export function NotFoundState({ as, back, action, title, body }: { as?: Heading; back?: StateLink; action?: ReactNode; title?: ReactNode; body?: ReactNode }) {
  const { t, L } = useI18n();
  return (
    <div className="state" role="alert">
      <Illustration name="search" />
      <StateHeading as={as}>{title ?? t('state.notfound')}</StateHeading>
      <p className="muted">{body ?? L('주소가 바뀌었거나 삭제된 항목일 수 있어요.', 'It may have moved or been removed.')}</p>
      <div className="actions">
        {action}
        {back && (
          <Link className="btn primary" href={back.href}>
            {back.label}
          </Link>
        )}
        <Link className={`btn ${back || action ? 'ghost' : 'primary'}`} href="/">
          {L('홈으로', 'Go home')}
        </Link>
      </div>
    </div>
  );
}

/** Empty state: title → explanation (children) → action, in reading order. */
export function EmptyState({ title, children, illo = 'generic', action, as }: { title?: ReactNode; children?: ReactNode; illo?: IlloName; action?: ReactNode; as?: Heading }) {
  const { t } = useI18n();
  return (
    <div className="state" role="status">
      <Illustration name={illo} />
      <StateHeading as={as}>{title ?? t('state.empty')}</StateHeading>
      {children && (typeof children === 'string' ? <p className="muted">{children}</p> : children)}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

/**
 * Standard loading / error / empty / permission wrapper (DoD: every UI route has these states).
 * `as="h1"` is passed to the error / empty headings when the state replaces the whole page.
 */
export function StateView<T>({
  state,
  isEmpty,
  empty,
  children,
  skeleton = 'list',
  as,
  back,
}: {
  state: { data: T | undefined; error: unknown; loading: boolean; reload?: () => void };
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (d: T) => ReactNode;
  skeleton?: 'list' | 'cards' | 'detail' | 'table';
  as?: Heading;
  back?: StateLink;
}) {
  const sk = skeleton === 'cards' ? <CardGridSkeleton /> : skeleton === 'detail' ? <DetailSkeleton /> : skeleton === 'table' ? <TableSkeleton /> : <ListSkeleton />;
  if (state.loading && state.data === undefined) return sk;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} as={as ?? (skeleton === 'detail' ? 'h1' : undefined)} back={back} />;
  if (state.data === undefined) return sk;
  if (isEmpty && isEmpty(state.data)) return <>{empty ?? <EmptyState as={as} />}</>;
  return <>{children(state.data)}</>;
}

export { ErrorText };
