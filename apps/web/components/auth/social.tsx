'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError, errorMessage, problemFromResponse } from '@/lib/errors';
import { getAccessToken } from '@/lib/token';

const PROVIDERS = [
  { id: 'google', ko: 'Google로 계속하기', en: 'Continue with Google', bg: '#ffffff', fg: '#1f1f1f', border: '#747775', mark: 'G' },
  { id: 'kakao', ko: '카카오로 계속하기', en: 'Continue with Kakao', bg: '#FEE500', fg: '#191919', border: '#FEE500', mark: '●' },
  { id: 'naver', ko: '네이버로 계속하기', en: 'Continue with Naver', bg: '#03A94D', fg: '#ffffff', border: '#03A94D', mark: 'N' },
] as const;

export interface ConsentDecision {
  type: string;
  version: string;
  granted: boolean;
}

/**
 * Start OAuth via the BFF: POST /api/auth/oauth/:provider/(start|link/start) → API returns {authorizationUrl, state};
 * the BFF binds `state` to this browser in an httpOnly cookie, then we navigate to the provider.
 * Plain-text buttons, no trademarked logos.
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
          <span aria-hidden="true" style={{ fontWeight: 900, width: 18 }}>{p.mark}</span> {p[lang]}
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
