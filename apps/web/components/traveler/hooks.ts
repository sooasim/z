'use client';
/**
 * Small cached lookups the traveler screens need to give bookings an identity (property title/photo, guide name,
 * departure time, conversation). List payloads don't embed these yet, so we resolve them client-side, de-duplicated
 * per page session. All lookups fail soft (undefined) — screens fall back to the booking code.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { item, items, str } from '@/lib/shape';
import { useAuth } from '@/lib/auth';

const cache = new Map<string, Promise<any>>();

function load<T = any>(path: string): Promise<T | undefined> {
  let p = cache.get(path);
  if (!p) {
    p = api<T>(path).catch(() => {
      // Don't cache failures forever: allow a retry on the next mount.
      setTimeout(() => cache.delete(path), 5000);
      return undefined;
    });
    cache.set(path, p);
  }
  return p;
}

/** Forget a cached path (after a mutation). */
export function invalidate(prefix: string) {
  for (const k of Array.from(cache.keys())) if (k.startsWith(prefix)) cache.delete(k);
}

/** Fetch one path through the shared cache. `null` skips. */
export function useCachedApi<T = any>(path: string | null): { data: T | undefined; loading: boolean } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(!!path);
  useEffect(() => {
    if (!path) {
      setData(undefined);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    load<T>(path).then((d) => {
      if (!alive) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return { data, loading };
}

/** Fetch many paths (deduplicated), returning { [path]: item }. */
export function useCachedMany(paths: string[]): Record<string, any> {
  const key = Array.from(new Set(paths.filter(Boolean))).sort().join('|');
  const [map, setMap] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const list = key.split('|');
    Promise.all(list.map((p) => load(p).then((d) => [p, d] as const))).then((pairs) => {
      if (!alive) return;
      setMap(Object.fromEntries(pairs.filter(([, d]) => d !== undefined).map(([p, d]) => [p, item(d) ?? d])));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return map;
}

export const propertyPath = (id: string) => (id ? `/v1/properties/${id}` : '');
export const guidePath = (id: string) => (id ? `/v1/guides/${id}` : '');

/** Properties by id. */
export function useProperties(ids: string[]): Record<string, any> {
  const m = useCachedMany(ids.map(propertyPath));
  return useMemo(() => Object.fromEntries(Object.entries(m).map(([p, v]) => [p.replace('/v1/properties/', ''), v])), [m]);
}

/** Guide public profiles by guide user id. */
export function useGuides(ids: string[]): Record<string, any> {
  const m = useCachedMany(ids.map(guidePath));
  return useMemo(() => Object.fromEntries(Object.entries(m).map(([p, v]) => [p.replace('/v1/guides/', ''), v])), [m]);
}

/** The signed-in user's conversations (cached for the page session). */
export function useConversations(): any[] {
  const { user } = useAuth();
  const { data } = useCachedApi<any>(user ? '/v1/conversations?limit=100' : null);
  return useMemo(() => items(data), [data]);
}

/** Conversation attached to a booking/exchange/order (contextType + contextId), if any. */
export function useConversationFor(contextType: string, contextId: string, explicitId?: string): any | undefined {
  const convs = useConversations();
  return useMemo(() => {
    if (explicitId) return convs.find((c) => str(c, 'id') === explicitId) ?? { id: explicitId };
    return convs.find((c) => str(c, 'contextType').toUpperCase() === contextType.toUpperCase() && str(c, 'contextId') === contextId);
  }, [convs, contextType, contextId, explicitId]);
}

/** Published travel products (for resolving order item → product photo/city/departure). */
export function useTravelProducts(enabled = true): any[] {
  const { data } = useCachedApi<any>(enabled ? '/v1/travel-products?limit=100' : null);
  return useMemo(() => items(data), [data]);
}

export interface DepartureInfo {
  productId: string;
  productTitle: string;
  city: string;
  startsAt: string;
  endsAt: string;
  cancellationTerms?: any;
}

/**
 * Departure time per order item. Order items carry only `sellableId` (departure id) + title, so we match the
 * product by title and look the departure up in its schedule (upcoming departures only — past ones stay unknown).
 */
export function useOrderDepartures(lines: any[]): Record<string, DepartureInfo> {
  const products = useTravelProducts(lines.length > 0);
  const wanted = useMemo(
    () =>
      lines
        .map((l) => {
          const title = str(l, 'title', 'productTitle', 'name');
          const p = products.find((x) => str(x, 'title') === title || str(x, 'id') === str(l, 'productId'));
          return p ? { sellableId: str(l, 'sellableId', 'departureId'), product: p } : null;
        })
        .filter(Boolean) as Array<{ sellableId: string; product: any }>,
    [lines, products],
  );
  const deps = useCachedMany(wanted.map((w) => `/v1/travel-products/${str(w.product, 'id')}/departures`));
  return useMemo(() => {
    const out: Record<string, DepartureInfo> = {};
    for (const w of wanted) {
      const list = items(deps[`/v1/travel-products/${str(w.product, 'id')}/departures`]);
      const dep = list.find((d: any) => str(d, 'id') === w.sellableId);
      out[w.sellableId] = {
        productId: str(w.product, 'id'),
        productTitle: str(w.product, 'title'),
        city: str(w.product, 'city'),
        startsAt: str(dep, 'startsAt', 'starts_at'),
        endsAt: str(dep, 'endsAt', 'ends_at'),
        cancellationTerms: (w.product as any)?.cancellationTerms,
      };
    }
    return out;
  }, [wanted, deps]);
}

/** Live countdown to an ISO timestamp: { left (ms), label 'mm:ss', expired }. */
export function useCountdown(iso: string | null | undefined) {
  const target = iso ? new Date(iso).getTime() : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!Number.isFinite(target)) return { left: NaN, label: '', expired: false, valid: false };
  const left = Math.max(0, target - now);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return { left, label: `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`, expired: left <= 0, valid: true };
}
