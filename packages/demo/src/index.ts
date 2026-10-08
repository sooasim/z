/**
 * JETPOOL static demo runtime. Loaded synchronously at the top of <head> (before the Next.js app boots) on the
 * GitHub Pages export. It answers every request to the demo API prefix (`…/__demo_api/v1/*`) and the BFF auth
 * routes (`/api/auth/*`) from recorded fixtures + browser-local state, so the real UI works with no server.
 */
import { loadFixtures } from './fixtures';
import { handleBff, fromAuthHeader, persona } from './auth';
import { handleApi } from './router';
import { FakeEventSource, realtimeResponse } from './realtime';
import { mountRibbon } from './ribbon';
import './domain';
import { json, nativeFetch, problem, sleep } from './util';

declare global {
  interface Window {
    __JETPOOL_DEMO__?: { base: string; ready: Promise<void>; version: string };
    __jpLoc?: any;
  }
}

(function boot() {
  if (window.__JETPOOL_DEMO__) return;
  const script = document.currentScript as HTMLScriptElement | null;
  const src = script?.src ? new URL(script.src, location.href) : null;
  const BASE = (src ? src.pathname.replace(/\/demo-backend\.js$/, '') : '').replace(/\/$/, '');

  // A root-relative navigation that already carried the basePath gets it twice (/z/z/…): fix it up.
  if (BASE && (location.pathname === BASE + BASE || location.pathname.startsWith(BASE + BASE + '/'))) {
    location.replace(location.pathname.slice(BASE.length) + location.search + location.hash);
    return;
  }

  /** Prefix root-relative app URLs with the basePath (and add the export's trailing slash). */
  const fixUrl = (u: any): any => {
    if (typeof u !== 'string' && !(u instanceof URL)) return u;
    let s = String(u);
    if (!s.startsWith('/') || s.startsWith('//')) return s;
    if (BASE && !(s === BASE || s.startsWith(BASE + '/') || s.startsWith(BASE + '?') || s.startsWith(BASE + '#'))) s = BASE + s;
    const cut = s.search(/[?#]/);
    const pathPart = cut < 0 ? s : s.slice(0, cut);
    const last = pathPart.split('/').pop() || '';
    if (!pathPart.endsWith('/') && !last.includes('.')) s = pathPart + '/' + (cut < 0 ? '' : s.slice(cut));
    return s;
  };
  const stripBase = (p: string) => (BASE && (p === BASE || p.startsWith(BASE + '/')) ? p.slice(BASE.length) || '/' : p);
  // Used by the export build, which rewrites `window.location.{href,pathname,assign,replace}` in the app copy.
  window.__jpLoc = {
    get href() {
      return location.href;
    },
    set href(u: string) {
      location.href = fixUrl(u);
    },
    get pathname() {
      return stripBase(location.pathname);
    },
    get search() {
      return location.search;
    },
    get hash() {
      return location.hash;
    },
    get origin() {
      return location.origin;
    },
    assign(u: string) {
      location.assign(fixUrl(u));
    },
    replace(u: string) {
      location.replace(fixUrl(u));
    },
    reload() {
      location.reload();
    },
    toString() {
      return location.href;
    },
  };

  const ready = loadFixtures(`${BASE}/demo-fixtures.json`, BASE).catch((e) => {
    console.error('[JETPOOL demo] could not load fixtures', e);
    throw e;
  });
  window.__JETPOOL_DEMO__ = { base: BASE, ready, version: '1' };

  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<any> {
    let raw: any = init?.body;
    if (raw === undefined && input instanceof Request) raw = await input.clone().text();
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if (raw instanceof FormData) return Object.fromEntries(raw.entries());
    return raw;
  }

  window.fetch = async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return nativeFetch(input as any, init);
    }
    const apiAt = url.pathname.indexOf('/__demo_api/');
    const isBff = url.origin === location.origin && (url.pathname.startsWith('/api/auth/') || (BASE && url.pathname.startsWith(BASE + '/api/auth/')));
    if (apiAt < 0 && !isBff) return nativeFetch(input as any, init);

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError();
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    await ready;
    const body = await readBody(input, init);
    let res: Response;
    if (isBff) {
      const sub = url.pathname.slice(url.pathname.indexOf('/api/auth/') + '/api/auth/'.length).replace(/\/+$/, '');
      res = handleBff(sub, method, body && typeof body === 'object' ? body : {}, BASE);
    } else {
      const path = url.pathname.slice(apiAt + '/__demo_api'.length).replace(/\/+$/, '') || '/';
      if (path === '/v1/realtime/stream') {
        const s = fromAuthHeader(headers.get('authorization'));
        const p = s ? persona(s.persona) : null;
        if (!p) return problem(401, 'UNAUTHENTICATED', 'Sign in required');
        return realtimeResponse(p.userId, signal);
      }
      if (path === '/health' || path === '/ready') return json(200, { status: 'ok', demo: true });
      // A short, natural-feeling latency so loading states render like the real app.
      await sleep(method === 'GET' ? 40 : 120);
      res = await handleApi(method, path, url.searchParams, headers, body, BASE);
    }
    if (signal?.aborted) throw abortError();
    return res;
  };

  const NativeES = window.EventSource;
  if (NativeES) {
    const Patched = function (this: any, u: string | URL, cfg?: EventSourceInit) {
      const s = String(u);
      if (s.includes('/__demo_api/')) return new FakeEventSource(s) as any;
      return new NativeES(u, cfg);
    } as any;
    Patched.prototype = NativeES.prototype;
    Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    window.EventSource = Patched;
  }

  // The PWA service worker would cache the export shell across demo rebuilds; keep the demo SW-free.
  try {
    const sw = navigator.serviceWorker;
    if (sw) {
      sw.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      (sw as any).register = () => Promise.resolve({ scope: location.origin + BASE + '/', unregister: () => Promise.resolve(true), update: () => Promise.resolve() });
    }
  } catch {
    /* ignore */
  }

  // Root-relative links rendered as plain <a href="/…"> (not next/link) need the basePath too.
  document.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/') || href.startsWith('//') || (BASE && (href === BASE || href.startsWith(BASE + '/')))) return;
      e.preventDefault();
      location.href = fixUrl(href);
    },
    true,
  );

  const mount = () => ready.then(() => setTimeout(mountRibbon, 300)).catch(() => {});
  if (document.readyState === 'complete') mount();
  else window.addEventListener('load', mount, { once: true });
})();
