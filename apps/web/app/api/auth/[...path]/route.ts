import { NextResponse, type NextRequest } from 'next/server';
import { API_INTERNAL_URL } from '@/lib/env';
import { REFRESH_COOKIE, cookieOptions, splitAuthPayload } from '@/lib/bff';

/**
 * BFF auth proxy. Forwards /api/auth/<path> → API /v1/auth/<path>.
 * Any `refreshToken` in an API response is removed from the JSON body and stored in an httpOnly,
 * SameSite=Lax (Secure in production/https) cookie scoped to /api/auth, so browser JS never sees it.
 * The access token is returned to the client and kept in memory only.
 */
export const dynamic = 'force-dynamic';

const ALLOWED = /^(signup|login|refresh|logout|logout-all|otp\/(request|verify)|oauth\/(google|kakao|naver)\/(start|callback|link\/start)|mfa\/(challenge|recovery-codes|totp\/(enroll|verify))|password\/(change|reset\/request|reset\/confirm)|email\/verify\/(request|confirm))$/;

function secureFor(req: NextRequest) {
  return process.env.NODE_ENV === 'production' || req.nextUrl.protocol === 'https:';
}

function forwardHeaders(req: NextRequest): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  const auth = req.headers.get('authorization');
  if (auth) h.authorization = auth;
  const ua = req.headers.get('user-agent');
  if (ua) h['user-agent'] = ua;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) h['x-forwarded-for'] = xff;
  const cid = req.headers.get('x-correlation-id');
  if (cid) h['x-correlation-id'] = cid;
  return h;
}

async function upstream(path: string, init: RequestInit) {
  try {
    return await fetch(`${API_INTERNAL_URL}/v1/auth/${path}`, { ...init, cache: 'no-store', redirect: 'manual' });
  } catch {
    return null;
  }
}

function problem(status: number, code: string, detail: string) {
  return NextResponse.json({ type: 'about:blank', title: code, status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { path } = await params;
  const p = path.join('/');
  // OAuth start: redirect the browser to the provider authorize URL obtained from the API.
  const m = /^oauth\/([a-z]+)\/start$/.exec(p);
  if (!m) return problem(404, 'NOT_FOUND', 'Unknown auth route');
  const provider = m[1];
  const returnTo = req.nextUrl.searchParams.get('returnTo');
  const res = await upstream(`oauth/${provider}/start`, {
    method: 'POST',
    headers: { ...forwardHeaders(req), 'content-type': 'application/json' },
    body: JSON.stringify(returnTo && /^\/[^/]/.test(returnTo) ? { returnTo } : {}),
  });
  if (!res) return NextResponse.redirect(new URL(`/login?error=OAUTH_UNAVAILABLE`, req.url));
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) return NextResponse.redirect(loc);
  if (res.ok) {
    const j: any = await res.json().catch(() => ({}));
    const url = j.authorizationUrl ?? j.url ?? j.authorizeUrl ?? j.item?.url;
    if (url) {
      const out = NextResponse.redirect(url);
      // Persist state server-side (httpOnly) so the callback can be bound to this browser.
      const state = j.state ?? j.item?.state;
      if (state) out.cookies.set('jp_oauth_state', String(state), { ...cookieOptions(secureFor(req)), maxAge: 600 });
      return out;
    }
  }
  return NextResponse.redirect(new URL(`/login?error=OAUTH_UNAVAILABLE&provider=${provider}`, req.url));
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { path } = await params;
  const p = path.join('/');
  if (!ALLOWED.test(p)) return problem(404, 'NOT_FOUND', 'Unknown auth route');

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const rt = req.cookies.get(REFRESH_COOKIE)?.value;
  if (p === 'refresh') {
    // Anonymous visitors: answer quietly (no console 401 noise); the client treats null as signed-out.
    if (!rt) return NextResponse.json({ accessToken: null, authenticated: false }, { status: 200, headers: { 'cache-control': 'no-store' } });
    body = { refreshToken: rt };
  }
  if (p === 'logout' && rt) body = { ...body, refreshToken: rt };
  if (p.startsWith('oauth/') && p.endsWith('/callback')) {
    const stateCookie = req.cookies.get('jp_oauth_state')?.value;
    if (stateCookie && body.state && stateCookie !== body.state) return problem(400, 'OAUTH_STATE_MISMATCH', 'OAuth state mismatch');
  }

  const res = await upstream(p, { method: 'POST', headers: { ...forwardHeaders(req), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res) return problem(502, 'NETWORK_ERROR', 'Auth service unreachable');

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  const secure = secureFor(req);

  if (!res.ok) {
    const out = new NextResponse(text || null, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/problem+json' } });
    if (p === 'refresh' && (res.status === 401 || res.status === 403)) out.cookies.set(REFRESH_COOKIE, '', { ...cookieOptions(secure), maxAge: 0 });
    return out;
  }

  const { publicBody, refreshToken, refreshMaxAge } = splitAuthPayload(json ?? {});
  const out = NextResponse.json(publicBody ?? {}, { status: res.status === 204 ? 200 : res.status });
  // OAuth start / link start: bind the state to this browser with an httpOnly cookie (checked on callback).
  if (/^oauth\/[a-z]+\/(start|link\/start)$/.test(p) && json?.state) out.cookies.set('jp_oauth_state', String(json.state), { ...cookieOptions(secure), maxAge: 600 });
  if (refreshToken) out.cookies.set(REFRESH_COOKIE, refreshToken, { ...cookieOptions(secure), maxAge: refreshMaxAge });
  if (p === 'logout') out.cookies.set(REFRESH_COOKIE, '', { ...cookieOptions(secure), maxAge: 0 });
  if (p.startsWith('oauth/') && p.endsWith('/callback')) out.cookies.set('jp_oauth_state', '', { ...cookieOptions(secure), maxAge: 0 });
  out.headers.set('cache-control', 'no-store');
  return out;
}
