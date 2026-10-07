/** Pure helpers for the BFF auth proxy (unit-tested). */
export const REFRESH_COOKIE = 'jp_rt';
const DEFAULT_REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

export function cookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/api/auth' };
}

/** Remove refresh token fields from an auth response; return the public body and the token. */
export function splitAuthPayload(json: any): { publicBody: any; refreshToken: string | null; refreshMaxAge: number } {
  if (!json || typeof json !== 'object') return { publicBody: json, refreshToken: null, refreshMaxAge: DEFAULT_REFRESH_MAX_AGE };
  const clone: any = Array.isArray(json) ? [...json] : { ...json };
  let token: string | null = null;
  let maxAge = DEFAULT_REFRESH_MAX_AGE;
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
    return c;
  };
  const top = scrub(clone);
  for (const k of ['tokens', 'item', 'session']) if (top[k] && typeof top[k] === 'object') top[k] = scrub(top[k]);
  return { publicBody: top, refreshToken: token, refreshMaxAge: maxAge };
}
