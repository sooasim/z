/** Dispatches an intercepted API request: stateful handlers first, then recorded fixtures, then a generic echo. */
import { fromAuthHeader, persona } from './auth';
import { narrow } from './fixtures';
import { recorded, routes, type Ctx } from './domain';
import { S, save } from './store';
import { json, nowIso, problem, uuid } from './util';

const PERSONAL = /^\/v1\/(reservations|exchanges|guide-bookings|guide-requests|orders|conversations|notifications|favorites|payments|receipts|me\/reviews|itineraries|collections|disputes|support\/cases|privacy\/requests|verifications|host-applications|consents)(\/|$)/;
const ANON_WRITES = /^\/v1\/(analytics|charter\/requests|consents|auth\/)/;

export async function handleApi(method: string, path: string, query: URLSearchParams, headers: Headers, body: any, base: string): Promise<Response> {
  const sess = fromAuthHeader(headers.get('authorization'));
  const p = sess ? persona(sess.persona) : null;
  const key = p ? p.key : 'anon';
  const ctx: Ctx = {
    method,
    path,
    query,
    body,
    key,
    p,
    aal: sess?.aal ?? null,
    chain: p ? (p.custom ? ['guest', 'anon'] : [p.key, 'anon']) : ['anon'],
    idem: headers.get('idempotency-key'),
    base,
  };
  const st = S();
  st.log.push({ at: nowIso(), method, path });
  const idemKey = ctx.idem && method !== 'GET' ? `${key}|${method} ${path}|${ctx.idem}` : null;
  if (idemKey && st.idem[idemKey]) {
    const r = st.idem[idemKey];
    return json(r.status, r.body, { 'idempotent-replayed': 'true' });
  }
  let res: Response | null = null;
  try {
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = re.exec(path);
      if (!match) continue;
      res = await h(ctx, ...match.slice(1).map((x) => decodeURIComponent(x)));
      if (res) break;
    }
    if (!res) res = method === 'GET' || method === 'HEAD' ? readFixture(ctx) : genericWrite(ctx);
  } catch (e) {
    console.error('[JETPOOL demo] handler error', method, path, e);
    res = problem(500, 'DEMO_ERROR', (e as Error)?.message || 'Demo runtime error');
  }
  if (idemKey && res.status < 300 && res.status !== 204) {
    try {
      st.idem[idemKey] = { status: res.status, body: await res.clone().json(), at: Date.now() };
      save();
    } catch {
      /* non-JSON */
    }
  }
  return res;
}

function readFixture(c: Ctx): Response {
  if (c.p?.custom && PERSONAL.test(c.path)) {
    const isList = !/\/[0-9a-f]{8}-[0-9a-f]{4}-/.test(c.path);
    return isList ? json(200, { items: [], nextCursor: null }) : problem(404, 'NOT_FOUND', 'Not found');
  }
  const h = recorded(c);
  if (!h) {
    if (!c.p && PERSONAL.test(c.path)) return problem(401, 'UNAUTHENTICATED', 'Sign in required');
    return problem(404, 'NOT_FOUND', `정적 데모에 기록되지 않은 요청입니다 / Not recorded in the static demo: GET ${c.path}`);
  }
  const body = h.exact ? h.body : narrow(h.body, c.query);
  return json(h.status, body);
}

function genericWrite(c: Ctx): Response {
  if (!c.p && !ANON_WRITES.test(c.path)) return problem(401, 'UNAUTHENTICATED', 'Sign in required');
  console.info('[JETPOOL demo] simulated', c.method, c.path, c.body ?? '');
  if (c.method === 'DELETE') return json(204, undefined);
  const b = c.body && typeof c.body === 'object' && !Array.isArray(c.body) ? c.body : {};
  const now = nowIso();
  if (c.method === 'POST') return json(201, { item: { id: uuid(), ...b, status: b.status ?? 'SUBMITTED', createdAt: now, updatedAt: now, demo: true }, demo: true });
  const h = recorded({ ...c, method: 'GET' } as Ctx);
  const cur = h && h.status < 300 ? (h.body?.item ?? h.body) : {};
  return json(200, { item: { ...(cur && typeof cur === 'object' ? cur : {}), ...b, updatedAt: now, demo: true }, demo: true });
}
