/**
 * Defensive response parsing. Backend modules may return `{ item }`, `{ items, nextCursor }`, `{ data }`,
 * a bare array, or raw snake_case rows. These helpers normalise without throwing so screens degrade gracefully.
 */
export type Obj = Record<string, any>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function items<T = Obj>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (!isObj(res)) return [];
  for (const k of ['items', 'data', 'results', 'hits', 'rows']) {
    const v = res[k];
    if (Array.isArray(v)) return v as T[];
    if (isObj(v) && Array.isArray(v.items)) return v.items as T[];
  }
  return [];
}

export function item<T = Obj>(res: unknown): T | null {
  if (!isObj(res)) return null;
  for (const k of ['item', 'data', 'result']) {
    if (isObj(res[k])) return res[k] as T;
  }
  return res as T;
}

export function nextCursor(res: unknown): string | null {
  if (!isObj(res)) return null;
  return (res.nextCursor ?? res.next_cursor ?? res.cursor ?? null) as string | null;
}

function snake(k: string): string {
  return k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}
function camel(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Read a field tolerating camelCase/snake_case and multiple candidate names: `f(o, 'priceMinor', 'amountMinor')`. */
export function f<T = any>(o: unknown, ...keys: string[]): T | undefined {
  if (!isObj(o)) return undefined;
  for (const k of keys) {
    if (k.includes('.')) {
      const [head, ...rest] = k.split('.');
      const v = f(o, head);
      const r = f(v, rest.join('.'));
      if (r !== undefined && r !== null) return r as T;
      continue;
    }
    for (const cand of [k, snake(k), camel(k)]) {
      if (o[cand] !== undefined && o[cand] !== null) return o[cand] as T;
    }
  }
  return undefined;
}

export function str(o: unknown, ...keys: string[]): string {
  const v = f(o, ...keys);
  return v === undefined || v === null ? '' : String(v);
}

export function num(o: unknown, ...keys: string[]): number | undefined {
  const v = f(o, ...keys);
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function arr<T = any>(o: unknown, ...keys: string[]): T[] {
  const v = f(o, ...keys);
  return Array.isArray(v) ? (v as T[]) : [];
}
