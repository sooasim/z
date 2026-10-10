'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RequestOptions } from './api';
import { ApiError } from './errors';
import { useAuth } from './auth';
import { useI18n } from './i18n';
import { intlLocale, type Lang } from './format';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/**
 * CMS reads (`/v1/content/*`) must carry the reader's locale. The API defaults that parameter to `ko-KR`, so
 * a request without it returns Korean copy whatever the UI language — which is how every content screen
 * stayed Korean. The API resolves per slug and falls back to `ko-KR` when a translation does not exist, so
 * asking can only improve the result. An explicit `locale` in `query` always wins.
 */
export function contentQuery(path: string | null, query: RequestOptions['query'], lang: Lang): RequestOptions['query'] {
  if (!path?.startsWith('/v1/content/')) return query;
  if (query && 'locale' in query) return query;
  return { ...(query ?? {}), locale: intlLocale(lang) };
}

/**
 * GET a resource. `path = null` skips the request (e.g. waiting for params).
 * `auth: true` waits for the session bootstrap and reports 401 if not signed in.
 *
 * The locale is part of the effect's dependencies, so switching language refetches CMS content.
 */
export function useApi<T = any>(path: string | null, opts: { query?: RequestOptions['query']; auth?: boolean } = {}): ApiState<T> {
  const { ready, user } = useAuth();
  const { lang } = useI18n();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const qs = JSON.stringify(contentQuery(path, opts.query, lang) ?? {});
  const waiting = opts.auth && !ready;
  const userId = user?.id;

  useEffect(() => {
    if (!path || waiting) {
      setLoading(!!path);
      return;
    }
    if (opts.auth && !userId) {
      setError(new ApiError(401, { code: 'UNAUTHENTICATED' }));
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { query: JSON.parse(qs), signal: ctrl.signal })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') return;
        setError(e);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, qs, tick, waiting, userId, opts.auth]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Run a mutation with pending/error state. */
export function useAction<A extends any[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(...a);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, setError };
}
