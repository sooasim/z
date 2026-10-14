/** Pure helpers for the BFF auth proxy (unit-tested). */
export const REFRESH_COOKIE = 'jp_rt';
const DEFAULT_REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

export function cookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/api/auth' };
}

/**
 * Remove refresh token fields from an auth response; return the public body and the token.
 *
 * The cookie is given the lifetime the API reports for the session, so the two end at the same moment: the
 * API slides `refreshExpiresAt` out on every rotation (identity/service.ts), which is what keeps an installed
 * app signed in until the reader logs out, and a cookie outliving the session would otherwise mean an app
 * launch that looks signed in and then 401s.
 */
export function splitAuthPayload(json: any, now: number = Date.now()): { publicBody: any; refreshToken: string | null; refreshMaxAge: number } {
  if (!json || typeof json !== 'object') return { publicBody: json, refreshToken: null, refreshMaxAge: DEFAULT_REFRESH_MAX_AGE };
  const clone: any = Array.isArray(json) ? [...json] : { ...json };
  let token: string | null = null;
  let maxAge: number | null = null;
  const scrub = (o: any) => {
    if (!o || typeof o !== 'object') return o;
    const c = { ...o };
    for (const k of ['refreshToken', 'refresh_token']) {
      if (typeof c[k] === 'string') {
        token = c[k];
        delete c[k];
      }
    }
    for (const k of ['refreshExpiresIn', 'refresh_expires_in']) {
      if (typeof c[k] === 'number' && c[k] > 0) maxAge = c[k];
    }
    // An absolute timestamp wins over a duration: it is what this API actually sends.
    for (const k of ['refreshExpiresAt', 'refresh_expires_at']) {
      if (typeof c[k] !== 'string') continue;
      const secs = Math.floor((Date.parse(c[k]) - now) / 1000);
      if (Number.isFinite(secs) && secs > 0) maxAge = secs;
    }
    return c;
  };
  const top = scrub(clone);
  for (const k of ['tokens', 'item', 'session']) if (top[k] && typeof top[k] === 'object') top[k] = scrub(top[k]);
  return { publicBody: top, refreshToken: token, refreshMaxAge: maxAge ?? DEFAULT_REFRESH_MAX_AGE };
}
