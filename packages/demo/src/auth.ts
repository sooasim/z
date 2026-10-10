/**
 * Demo sessions + an emulation of the web's BFF auth routes (`/api/auth/*`, see apps/web/app/api/auth).
 * Persona is chosen at login by email; the "access token" is an unsigned JWT-shaped string the web can decode
 * for display, and every intercepted API call maps its Authorization header back to the persona.
 */
import { F } from './fixtures';
import { ACCOUNTS_KEY, SESSION_KEY, S, readJson, save, writeJson } from './store';
import { base64url, clone, json, nowIso, problem, unbase64url, uuid, type Obj } from './util';

export interface Persona {
  key: string;
  userId: string;
  email: string;
  displayName: string;
  roles: string[];
  /** Fixture persona used for recorded responses. */
  base: string;
  custom: boolean;
}

export interface Account {
  key: string;
  userId: string;
  email: string;
  displayName: string;
  password: string;
  createdAt: string;
}

export const PERSONA_ORDER = ['guest', 'host', 'exchange', 'guide', 'proGuide', 'hostJeju', 'supplier', 'admin'];
export const PERSONA_LABEL: Record<string, [string, string]> = {
  guest: ['게스트', 'Guest'],
  host: ['호스트(서울)', 'Host (Seoul)'],
  hostJeju: ['호스트(제주)', 'Host (Jeju)'],
  exchange: ['맞교환 회원', 'Exchange member'],
  guide: ['가이드 프렌드', 'Guide friend'],
  proGuide: ['전문 가이드', 'Pro guide'],
  supplier: ['여행 공급사', 'Supplier'],
  admin: ['관리자', 'Admin'],
};

export function accounts(): Account[] {
  return readJson<Account[]>(ACCOUNTS_KEY, []);
}

export function persona(key: string | null | undefined): Persona | null {
  if (!key || key === 'anon') return null;
  const p = F.personas[key];
  if (p) return { key, userId: p.userId, email: p.email, displayName: S().patches[key]?.profile?.displayName || p.displayName, roles: p.roles, base: key, custom: false };
  const a = accounts().find((x) => x.key === key);
  if (a) return { key, userId: a.userId, email: a.email, displayName: S().patches[key]?.profile?.displayName || a.displayName, roles: ['USER'], base: 'guest', custom: true };
  return null;
}

export function personaByEmail(email: string): Persona | null {
  const e = (email || '').trim().toLowerCase();
  for (const k of Object.keys(F.personas)) if (F.personas[k].email.toLowerCase() === e) return persona(k);
  const a = accounts().find((x) => x.email.toLowerCase() === e);
  return a ? persona(a.key) : null;
}

/**
 * Login handles (`users.username` in the real API) and the password that goes with them. The admin console
 * (`/admin/login`) signs in with `admin` / `admin1234`; the shared demo password works there too.
 */
export const PERSONA_USERNAME: Record<string, string> = { admin: 'admin' };
export const USERNAME_PASSWORD: Record<string, string> = { admin: 'admin1234' };

export function personaByUsername(name: string): Persona | null {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  for (const [k, u] of Object.entries(PERSONA_USERNAME)) if (u === n && F.personas[k]) return persona(k);
  return null;
}

export function personaByUserId(id: string): Persona | null {
  for (const k of Object.keys(F.personas)) if (F.personas[k].userId === id) return persona(k);
  const a = accounts().find((x) => x.userId === id);
  return a ? persona(a.key) : null;
}

export interface Session {
  persona: string;
  aal: 'aal1' | 'aal2';
  sid: string;
  at: string;
}
export function session(): Session | null {
  const s = readJson<Session | null>(SESSION_KEY, null);
  return s && persona(s.persona) ? s : null;
}
export function setSession(key: string | null, aal: 'aal1' | 'aal2' = 'aal1') {
  if (!key) writeJson(SESSION_KEY, null);
  else writeJson(SESSION_KEY, { persona: key, aal, sid: uuid(), at: nowIso() });
}

export function tokenFor(s: Session): string {
  const p = persona(s.persona)!;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', demo: true }));
  const payload = base64url(JSON.stringify({ sub: p.userId, sid: s.sid, aal: s.aal, persona: p.key, iss: 'jetpool-demo', iat: now, exp: now + 86400 * 30 }));
  return `${header}.${payload}.demo`;
}

/** Map an Authorization header to the demo persona (null = anonymous). */
export function fromAuthHeader(h: string | null): Session | null {
  if (!h || !/^Bearer /i.test(h)) return null;
  const parts = h.slice(7).trim().split('.');
  if (parts.length < 2) return null;
  try {
    const c = JSON.parse(unbase64url(parts[1]));
    if (!c?.persona || !persona(c.persona)) return null;
    return { persona: c.persona, aal: c.aal === 'aal2' ? 'aal2' : 'aal1', sid: c.sid, at: '' };
  } catch {
    return null;
  }
}

export function mfaEnabled(key: string): boolean {
  const patch = S().patches[key]?.mfa;
  if (patch) return !!patch.enabled;
  return !!F.personas[key]?.login?.user?.mfaEnabled || key === 'admin';
}

/** `/v1/me`-shaped user for a persona (recorded body for fixture personas, derived for signups). */
export function userOf(p: Persona): Obj {
  const rec = F.personas[p.base]?.login?.user ?? {};
  const u = clone(rec);
  if (p.custom) {
    Object.assign(u, { id: p.userId, email: p.email, displayName: p.displayName, roles: ['USER'], linkedProviders: [], identityVerified: false, createdAt: accounts().find((a) => a.key === p.key)?.createdAt ?? nowIso() });
  }
  u.displayName = p.displayName;
  u.mfaEnabled = mfaEnabled(p.key);
  const linked = S().patches[p.key]?.identities?.linked as string[] | undefined;
  if (linked) u.linkedProviders = linked;
  u.lastLoginAt = nowIso();
  return u;
}

function loginBody(s: Session): Obj {
  const p = persona(s.persona)!;
  const rec = clone(F.personas[p.base]?.login ?? {});
  delete rec.refreshToken;
  return { ...rec, accessToken: tokenFor(s), tokenType: 'Bearer', expiresIn: 86400 * 30, sessionId: s.sid, aal: s.aal, user: userOf(p), demo: true };
}

const DEMO_EMAILS = () => Object.values(F.personas).map((p) => p.email);
const invalid = () =>
  problem(401, 'INVALID_CREDENTIALS', `이메일 또는 비밀번호가 올바르지 않습니다. 데모 계정: ${DEMO_EMAILS().join(', ')} / 비밀번호 ${F.password}`, { demoAccounts: DEMO_EMAILS(), demoPassword: F.password });
/** Handle sign-in (`/admin/login`) — the hint names the handles, not the member emails. */
const invalidHandle = () => {
  const list = Object.entries(PERSONA_USERNAME).map(([k, u]) => `${u} / ${USERNAME_PASSWORD[k] ?? F.password}`);
  return problem(401, 'INVALID_CREDENTIALS', `아이디 또는 비밀번호가 올바르지 않습니다. 데모 관리자 계정: ${list.join(', ')}`, { demoAdminLogins: list });
};

function startSession(key: string, aal?: 'aal1' | 'aal2'): Response {
  // Demo shortcut: personas with an authenticator are signed in at AAL2 right away (no TOTP device in a static demo).
  setSession(key, aal ?? (mfaEnabled(key) ? 'aal2' : 'aal1'));
  return json(200, loginBody(session()!), { 'cache-control': 'no-store' });
}

export function demoOAuthUrl(base: string, provider: string): string {
  return `${location.origin}${base}/auth/callback/${provider}/?code=demo-${provider}-${Date.now().toString(36)}&state=demo`;
}

/** POST/GET /api/auth/<sub> */
export function handleBff(sub: string, method: string, body: Obj, base: string): Response {
  const s = session();
  const m = /^oauth\/([a-z]+)\/(start|callback|link\/start)$/.exec(sub);
  if (method === 'GET') {
    if (m && m[2] === 'start') return new Response(null, { status: 302, headers: { location: demoOAuthUrl(base, m[1]) } });
    return problem(404, 'NOT_FOUND', 'Unknown auth route');
  }
  switch (sub) {
    case 'refresh':
      if (!s) return json(200, { accessToken: null, authenticated: false }, { 'cache-control': 'no-store' });
      return json(200, { accessToken: tokenFor(s), tokenType: 'Bearer', expiresIn: 86400 * 30, aal: s.aal, sessionId: s.sid, user: userOf(persona(s.persona)!) }, { 'cache-control': 'no-store' });
    case 'login': {
      const handle = String(body.username || '');
      const p = handle ? personaByUsername(handle) : personaByEmail(String(body.email || ''));
      if (!p) return handle ? invalidHandle() : invalid();
      const acct = accounts().find((a) => a.key === p.key);
      const pw = String(body.password || '');
      const accepted = [F.password, acct?.password, USERNAME_PASSWORD[p.key]].filter(Boolean) as string[];
      if (!accepted.includes(pw)) return handle ? invalidHandle() : invalid();
      return startSession(p.key);
    }
    case 'logout':
    case 'logout-all':
      setSession(null);
      return json(200, sub === 'logout-all' ? { revoked: 1 } : {});
    case 'signup': {
      const email = String(body.email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return problem(400, 'VALIDATION_FAILED', '올바른 이메일을 입력하세요.');
      if (personaByEmail(email)) return problem(409, 'EMAIL_TAKEN', '이미 가입된 이메일입니다. 로그인해 주세요.');
      const key = `acct:${uuid()}`;
      const list = accounts();
      list.push({ key, userId: uuid(), email, displayName: String(body.displayName || body.name || email.split('@')[0]).slice(0, 80), password: String(body.password || F.password), createdAt: nowIso() });
      writeJson(ACCOUNTS_KEY, list);
      const r = startSession(key, 'aal1');
      return new Response(r.body, { status: 201, headers: r.headers });
    }
    case 'otp/request':
      return json(202, { accepted: true, challengeId: uuid(), expiresIn: 600, demoHint: '데모: 아무 6자리 코드나 입력하세요 / any 6-digit code works' });
    case 'otp/verify': {
      if (!/^\d{6}$/.test(String(body.code || ''))) return problem(400, 'INVALID_CODE', '6자리 코드를 입력하세요.');
      const p = personaByEmail(String(body.email || ''));
      if (!p) return problem(401, 'INVALID_CODE', `데모에서는 등록된 데모 이메일만 코드 로그인이 됩니다: ${DEMO_EMAILS().join(', ')}`);
      return startSession(p.key);
    }
    case 'mfa/challenge': {
      if (!s) return problem(401, 'UNAUTHENTICATED', 'Sign in first');
      if (!body.code && !body.recoveryCode) return problem(400, 'INVALID_CODE', 'Code required');
      setSession(s.persona, 'aal2');
      const ns = session()!;
      return json(200, { accessToken: tokenFor(ns), aal: 'aal2', sessionId: ns.sid });
    }
    case 'mfa/totp/enroll': {
      if (!s) return problem(401, 'UNAUTHENTICATED', 'Sign in first');
      const p = persona(s.persona)!;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => alphabet[b % 32]).join('');
      return json(201, { factorId: uuid(), secret, otpauthUrl: `otpauth://totp/JETPOOL:${encodeURIComponent(p.email)}?secret=${secret}&issuer=JETPOOL&period=30&digits=6`, period: 30, digits: 6, demoHint: '데모: 아무 6자리 코드나 입력하세요' });
    }
    case 'mfa/totp/verify':
    case 'mfa/recovery-codes': {
      if (!s) return problem(401, 'UNAUTHENTICATED', 'Sign in first');
      const codes = Array.from({ length: 10 }, () => `${Math.random().toString(16).slice(2, 7)}-${Math.random().toString(16).slice(2, 7)}`);
      if (sub === 'mfa/recovery-codes') return json(200, { recoveryCodes: codes });
      ((S().patches[s.persona] ||= {}).mfa = { enabled: true }), save();
      setSession(s.persona, 'aal2');
      const ns = session()!;
      return json(200, { factorId: body.factorId, recoveryCodes: codes, accessToken: tokenFor(ns), aal: 'aal2' });
    }
    case 'password/change':
    case 'password/reset/confirm':
      return json(204, undefined);
    case 'password/reset/request':
    case 'email/verify/request':
      return json(202, { accepted: true });
    case 'email/verify/confirm':
      return json(200, { emailVerified: true });
  }
  if (m) {
    const [, provider, action] = m;
    if (action === 'start' || action === 'link/start') {
      try {
        sessionStorage.setItem('jpdemo:oauth', action === 'link/start' ? 'link' : 'login');
      } catch {
        /* ignore */
      }
      return json(200, { authorizationUrl: demoOAuthUrl(base, provider), state: 'demo', provider });
    }
    // callback
    let mode = 'login';
    try {
      mode = sessionStorage.getItem('jpdemo:oauth') || 'login';
      sessionStorage.removeItem('jpdemo:oauth');
    } catch {
      /* ignore */
    }
    if (mode === 'link' && s) {
      const pt = (S().patches[s.persona] ||= {});
      const linked = new Set<string>((pt.identities?.linked as string[]) ?? []);
      linked.add(provider.toUpperCase());
      pt.identities = { linked: [...linked] };
      save();
      return json(200, { linked: true, provider });
    }
    const r = startSession(s?.persona ?? 'guest');
    return r;
  }
  return problem(404, 'NOT_FOUND', 'Unknown auth route');
}
