'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** Value that settles `ms` after the last change (search-as-you-type without a request per keystroke). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Mirror filter state into the URL (router.replace, no scroll) so results can be shared and survive reloads.
 * Empty values are dropped; arrays become repeated params.
 */
export function useUrlSync(params: Record<string, string | string[] | undefined>) {
  const router = useRouter();
  const path = usePathname();
  const first = useRef(true);
  const qs = (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.filter(Boolean).forEach((x) => p.append(k, x));
      else if (v) p.set(k, v);
    }
    return p.toString();
  })();
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const cur = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
    if (cur === qs) return;
    router.replace(`${path}${qs ? `?${qs}` : ''}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);
}
