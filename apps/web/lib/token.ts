/**
 * Access token lives ONLY in memory (never localStorage). The refresh token is an httpOnly cookie managed by the
 * Next BFF route `/api/auth/*`, so XSS cannot exfiltrate it. On reload the AuthProvider calls /api/auth/refresh.
 */
type Listener = (token: string | null) => void;
let accessToken: string | null = null;
const listeners = new Set<Listener>();

export function getAccessToken(): string | null {
  return accessToken;
}
export function setAccessToken(t: string | null) {
  accessToken = t;
  for (const l of listeners) l(t);
}
export function onTokenChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Decode JWT claims (no verification — display/UX only; the API is the authority). */
export function decodeJwt(token: string | null): Record<string, any> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = typeof atob === 'function' ? atob(pad) : Buffer.from(pad, 'base64').toString('binary');
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

let refreshing: Promise<string | null> | null = null;
/** Single-flight refresh via the BFF (cookie is sent automatically, same-origin). */
export function refreshAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async (r) => {
        if (!r.ok) {
          setAccessToken(null);
          return null;
        }
        const j = await r.json().catch(() => ({}));
        const t = (j.accessToken ?? j.access_token ?? j.item?.accessToken ?? null) as string | null;
        setAccessToken(t);
        return t;
      })
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}
