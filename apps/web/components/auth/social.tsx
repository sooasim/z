'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError, errorMessage, problemFromResponse } from '@/lib/errors';
import { getAccessToken } from '@/lib/token';
import { pickText } from '@/lib/phrases';

/**
 * Provider buttons per each brand's login-button guideline:
 * - Google: white, #747775 outline, multicolour "G", #1f1f1f label
 * - Kakao: #FEE500 container, black speech-bubble symbol, label black at 85% opacity
 * - Naver: white variant with the green "N" mark and dark label (the white-on-green variant is only 3.1:1)
 */
const PROVIDERS = [
  { id: 'google', ko: 'Google로 계속하기', en: 'Continue with Google', bg: '#ffffff', fg: '#1f1f1f', border: '#747775' },
  { id: 'kakao', ko: '카카오로 계속하기', en: 'Continue with Kakao', bg: '#FEE500', fg: 'rgba(0, 0, 0, 0.85)', border: '#FEE500' },
  { id: 'naver', ko: '네이버로 계속하기', en: 'Continue with Naver', bg: '#ffffff', fg: '#1f1f1f', border: '#c9ced6' },
] as const;

function ProviderMark({ id }: { id: string }) {
  if (id === 'google')
    return (
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  if (id === 'kakao')
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="#000000" d="M12 3C6.48 3 2 6.58 2 11c0 2.86 1.88 5.37 4.7 6.78-.2.73-.74 2.68-.85 3.1-.13.52.19.51.4.37.17-.11 2.66-1.8 3.73-2.53.66.1 1.33.15 2.02.15 5.52 0 10-3.58 10-8S17.52 3 12 3z" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#03C75A" d="M16.27 12.84 7.46 0H0v24h7.73V11.16L16.54 24H24V0h-7.73z" />
    </svg>
  );
}

export interface ConsentDecision {
  type: string;
  version: string;
  granted: boolean;
}

/**
 * Start OAuth via the BFF: POST /api/auth/oauth/:provider/(start|link/start) → API returns {authorizationUrl, state};
 * the BFF binds `state` to this browser in an httpOnly cookie, then we navigate to the provider.
 */
export async function startOAuth(provider: string, opts: { link?: boolean; returnTo?: string; consents?: ConsentDecision[] } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = getAccessToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(`/api/auth/oauth/${provider}/${opts.link ? 'link/start' : 'start'}`, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(opts.link ? {} : { returnTo: opts.returnTo && opts.returnTo !== '/' ? opts.returnTo : undefined, consents: opts.consents?.length ? opts.consents : undefined }),
  });
  if (!res.ok) throw new ApiError(res.status, await problemFromResponse(res));
  const j = await res.json();
  const url = j.authorizationUrl ?? j.url;
  if (!url) throw new ApiError(502, { code: 'OAUTH_UNAVAILABLE' });
  try {
    sessionStorage.setItem('jp_next', opts.returnTo ?? '/');
  } catch {
    /* ignore */
  }
  window.location.assign(url);
}

export function SocialButtons({ next, consents, disabled }: { next?: string; consents?: ConsentDecision[]; disabled?: boolean }) {
  const { lang } = useI18n();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="stack">
      {PROVIDERS.map((p) => (
        <button
          key={p.id}
          type="button"
          className="btn block lg"
          style={{ background: p.bg, color: p.fg, borderColor: p.border }}
          disabled={disabled || !!busy}
          data-loading={busy === p.id ? 'true' : undefined}
          onClick={async () => {
            setBusy(p.id);
            setErr(null);
            try {
              await startOAuth(p.id, { returnTo: next, consents });
            } catch (e) {
              setErr(e);
              setBusy(null);
            }
          }}
        >
          <span aria-hidden="true" style={{ width: 22, display: 'inline-grid', placeItems: 'center', position: 'absolute', left: 18 }}>
            <ProviderMark id={p.id} />
          </span>
          {pickText(p, lang)}
        </button>
      ))}
      {err ? <p role="alert" className="small" style={{ color: 'var(--danger)', margin: 0 }}>{errorMessage(err, lang)}</p> : null}
    </div>
  );
}

export function safeNext(n: string | null | undefined): string {
  if (!n || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/api/')) return '/';
  return n;
}
