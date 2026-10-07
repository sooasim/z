import { describe, expect, it } from 'vitest';
import { REFRESH_COOKIE, cookieOptions, splitAuthPayload } from '@/lib/bff';
import { decodeJwt } from '@/lib/token';

describe('BFF refresh-token handling', () => {
  it('strips refreshToken from the public body (top level and nested)', () => {
    const r = splitAuthPayload({ accessToken: 'a', refreshToken: 'r1', refreshExpiresIn: 3600, user: { id: 'u' } });
    expect(r.refreshToken).toBe('r1');
    expect(r.refreshMaxAge).toBe(3600);
    expect(r.publicBody).toEqual({ accessToken: 'a', refreshExpiresIn: 3600, user: { id: 'u' } });
    const n = splitAuthPayload({ tokens: { access_token: 'a', refresh_token: 'r2' } });
    expect(n.refreshToken).toBe('r2');
    expect(JSON.stringify(n.publicBody)).not.toContain('r2');
  });
  it('passes through bodies without tokens', () => {
    expect(splitAuthPayload({ mfaRequired: true }).refreshToken).toBeNull();
    expect(splitAuthPayload(null).publicBody).toBeNull();
  });
  it('uses httpOnly SameSite=Lax cookie scoped to /api/auth', () => {
    expect(REFRESH_COOKIE).toBe('jp_rt');
    expect(cookieOptions(true)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth' });
  });
  it('decodes JWT claims for UX only', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', aal: 'aal2' })).toString('base64url');
    expect(decodeJwt(`x.${payload}.y`)).toMatchObject({ sub: 'u1', aal: 'aal2' });
    expect(decodeJwt('garbage')).toBeNull();
  });
});
