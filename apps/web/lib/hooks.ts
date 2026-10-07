'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RequestOptions } from './api';
import { ApiError } from './errors';
import { useAuth } from './auth';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/**
 * GET a resource. `path = null` skips the request (e.g. waiting for params).
 * `auth: true` waits for the session bootstrap and reports 401 if not signed in.
 */
export function useApi<T = any>(path: string | null, opts: { query?: RequestOptions['query']; auth?: boolean } = {}): ApiState<T> {
  const { ready, user } = useAuth();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const qs = JSON.stringify(opts.query ?? {});
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
