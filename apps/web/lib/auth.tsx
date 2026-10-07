'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { decodeJwt, getAccessToken, onTokenChange, refreshAccessToken, setAccessToken } from './token';
import { ApiError, problemFromResponse } from './errors';
import { arr, f, item, str } from './shape';

export const STAFF_ROLES = ['ADMIN', 'ACCOUNTING', 'SUPPORT', 'EDITOR', 'OPS', 'COMPLIANCE'] as const;

export interface User {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  aal: 'aal1' | 'aal2';
  mfaEnabled: boolean;
  raw: any;
}

interface AuthCtx {
  ready: boolean;
  user: User | null;
  hasRole: (...roles: string[]) => boolean;
  isStaff: boolean;
  /** POST through the BFF so the refresh token is stored in an httpOnly cookie. */
  authCall: (path: string, body?: unknown) => Promise<any>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  ready: false,
  user: null,
  hasRole: () => false,
  isStaff: false,
  authCall: async () => ({}),
  logout: async () => {},
  reloadMe: async () => {},
});

function toUser(me: any, token: string | null): User | null {
  const u = item(me) ?? me;
  const claims = decodeJwt(token) || {};
  const user = f(u, 'user') ?? u;
  const id = str(user, 'id', 'userId') || String(claims.sub || '');
  if (!id) return null;
  const rolesRaw = arr(u, 'roles').length ? arr(u, 'roles') : arr(user, 'roles');
  const roles = rolesRaw.map((r: any) => (typeof r === 'string' ? r : str(r, 'role', 'name'))).filter(Boolean);
  return {
    id,
    email: str(user, 'email'),
    displayName: str(user, 'displayName', 'name', 'profile.displayName') || str(user, 'email').split('@')[0],
    roles: roles.length ? roles : ['USER'],
    aal: (str(u, 'aal', 'session.aal') || claims.aal || 'aal1') as 'aal1' | 'aal2',
    mfaEnabled: Boolean(f(user, 'mfaEnabled', 'mfa_enabled', 'totpEnabled') ?? f(u, 'mfaEnabled')),
    raw: u,
  };
}

/** Extract tokens from varied API auth responses. */
export function extractAccessToken(j: any): string | null {
  return (j?.accessToken ?? j?.access_token ?? j?.item?.accessToken ?? j?.tokens?.accessToken ?? null) as string | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  const loadMe = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setUser(null);
      return;
    }
    try {
      const me = await api('/v1/me');
      setUser(toUser(me, getAccessToken()));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else setUser(toUser({}, token)); // API degraded: fall back to JWT claims
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshAccessToken();
      if (!cancelled) await loadMe();
      if (!cancelled) setReady(true);
    })();
    const off = onTokenChange((t) => {
      if (!t) setUser(null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [loadMe]);

  const authCall = useCallback(
    async (path: string, body: unknown = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const t = getAccessToken();
      if (t) headers.authorization = `Bearer ${t}`;
      const res = await fetch(`/api/auth/${path.replace(/^\//, '')}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, await problemFromResponse(res));
      const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
      const at = extractAccessToken(j);
      if (at) {
        setAccessToken(at);
        await loadMe();
      }
      return j;
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    try {
      await authCall('logout', {});
    } catch {
      /* best effort */
    }
    setAccessToken(null);
    setUser(null);
  }, [authCall]);

  const value = useMemo<AuthCtx>(() => {
    const roles = user?.roles ?? [];
    return {
      ready,
      user,
      hasRole: (...r) => r.some((x) => roles.includes(x)),
      isStaff: roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r)),
      authCall,
      logout,
      reloadMe: loadMe,
    };
  }, [ready, user, authCall, logout, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
