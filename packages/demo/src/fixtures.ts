/** Recorded API fixtures (packages/demo/fixtures/api.json) and the lookup with fallbacks. */
import { clone, itemsOf, nativeFetch, sortedQuery, type Obj } from './util';

export interface Fixtures {
  version: number;
  recordedAt: string;
  password: string;
  personas: Record<string, { email: string; userId: string; displayName: string; roles: string[]; aal: string; login: Obj }>;
  ids: Record<string, string[]>;
  idPool: Record<string, string[]>;
  templates: Obj;
  bodies: Record<string, any>;
  responses: Record<string, { status: number; body: string }>;
}

export let F: Fixtures = null as any;
/** persona|path → [{ params, key }] */
const index = new Map<string, Array<{ params: URLSearchParams; key: string }>>();

const ASSET = /^\/(placeholder|art|icons)\//;

/** Root-relative asset URLs recorded from the API (e.g. '/placeholder/1.svg') must live under the Pages basePath. */
function rewriteAssets(v: any, base: string): any {
  if (typeof v === 'string') return ASSET.test(v) ? base + v : v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = rewriteAssets(v[i], base);
    return v;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = rewriteAssets(v[k], base);
  }
  return v;
}
export const assetUrl = (s: string, base: string) => (typeof s === 'string' && ASSET.test(s) ? base + s : s);

export async function loadFixtures(url: string, base: string): Promise<void> {
  const res = await nativeFetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`demo fixtures: HTTP ${res.status}`);
  F = await res.json();
  for (const k of Object.keys(F.bodies)) F.bodies[k] = rewriteAssets(F.bodies[k], base);
  F.templates = rewriteAssets(F.templates || {}, base);
  for (const key of Object.keys(F.responses)) {
    const bar = key.indexOf('|GET ');
    const persona = key.slice(0, bar);
    const rest = key.slice(bar + 5);
    const q = rest.indexOf('?');
    const p = q < 0 ? rest : rest.slice(0, q);
    const params = new URLSearchParams(q < 0 ? '' : rest.slice(q + 1));
    const ik = `${persona}|${p}`;
    if (!index.has(ik)) index.set(ik, []);
    index.get(ik)!.push({ params, key });
  }
}

export interface Hit {
  status: number;
  body: any;
  exact: boolean;
  persona: string;
  key: string;
}

/** Query keys whose value changes the result set (mismatch = strong penalty). */
const STRONG = new Set(['q', 'city', 'targetId', 'targetType', 'propertyId', 'filter', 'role', 'status', 'type', 'unread', 'mode', 'checkIn', 'checkOut', 'guests', 'contextType', 'subjectId', 'subjectType', 'orderId', 'paymentId', 'kind', 'tab']);

function score(want: URLSearchParams, have: URLSearchParams): number {
  let s = 0;
  for (const [k, v] of want) {
    const h = have.get(k);
    if (h === v) s += 3;
    else if (h !== null) s -= STRONG.has(k) ? 6 : 0.5;
    else s -= STRONG.has(k) ? 2 : 0.1;
  }
  for (const [k] of have) if (!want.has(k)) s -= STRONG.has(k) ? 4 : 0.3;
  return s;
}

/** Exact match, else best query match for the same path. Returns a deep clone. */
export function lookupFor(persona: string, path: string, query: URLSearchParams): Hit | null {
  const qs = sortedQuery(query);
  const exactKey = `${persona}|GET ${path}${qs ? '?' + qs : ''}`;
  const ex = F.responses[exactKey];
  if (ex) return { status: ex.status, body: clone(F.bodies[ex.body]), exact: true, persona, key: exactKey };
  const cands = index.get(`${persona}|${path}`);
  if (!cands?.length) return null;
  let best = cands[0];
  let bs = -Infinity;
  for (const c of cands) {
    const sc = score(query, c.params);
    if (sc > bs) {
      bs = sc;
      best = c;
    }
  }
  const r = F.responses[best.key];
  return { status: r.status, body: clone(F.bodies[r.body]), exact: false, persona, key: best.key };
}

export function hasRecord(persona: string, path: string): boolean {
  return index.has(`${persona}|${path}`);
}

/** Persona chain lookup: persona → base persona → anonymous. */
export function lookup(chain: string[], path: string, query: URLSearchParams): Hit | null {
  for (const p of chain) {
    const h = lookupFor(p, path, query);
    if (h) return h;
  }
  return null;
}

/** First recorded 2xx body for a path from any persona (used to find entity templates). */
export function anyBody(path: string, prefer: string[] = []): any {
  for (const p of [...prefer, ...Object.keys(F.personas), 'anon']) {
    const c = index.get(`${p}|${path}`);
    if (!c) continue;
    for (const x of c) {
      const r = F.responses[x.key];
      if (r.status < 300) return clone(F.bodies[r.body]);
    }
  }
  return undefined;
}

/** All recorded list items under a path prefix (deduped by id). */
export function allItems(pathPred: (p: string) => boolean, personaPred: (p: string) => boolean = () => true): Obj[] {
  const seen = new Map<string, Obj>();
  for (const [ik, cands] of index) {
    const bar = ik.indexOf('|');
    if (!personaPred(ik.slice(0, bar)) || !pathPred(ik.slice(bar + 1))) continue;
    for (const c of cands) {
      const r = F.responses[c.key];
      if (r.status >= 300) continue;
      for (const it of itemsOf(F.bodies[r.body])) {
        const id = it?.id ?? it?.guide?.guideId ?? JSON.stringify(it).slice(0, 80);
        if (!seen.has(id)) seen.set(id, it);
      }
    }
  }
  return [...seen.values()].map(clone);
}

/** Generic narrowing for fuzzy list matches: filter by simple query keys that exist on items, then apply limit. */
const META = new Set(['limit', 'cursor', 'page', 'sort', 'q', 'from', 'to', 'offset', 'order', 'include', 'expand', 'role', 'auth']);
export function narrow(body: any, query: URLSearchParams): any {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return body;
  let rows: any[] = body.items;
  for (const [k, v] of query) {
    if (META.has(k) || !v || v.includes(',')) continue;
    const has = rows.some((r) => r && typeof r === 'object' && (k in r || k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()) in r));
    if (!has) continue;
    rows = rows.filter((r) => String(r[k] ?? r[k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())] ?? '').toLowerCase() === v.toLowerCase());
  }
  const q = query.get('q');
  if (q && rows.length) {
    const ql = q.toLowerCase();
    const hit = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(ql));
    rows = hit;
  }
  const limit = Number(query.get('limit'));
  if (limit > 0 && rows.length > limit) rows = rows.slice(0, limit);
  return { ...body, items: rows, ...(typeof body.total === 'number' ? { total: rows.length } : {}) };
}
