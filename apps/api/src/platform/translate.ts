import { createHash } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Machine translation of member-written content (listing copy, review bodies, host/guide bios) into the
 * reader's language.
 *
 * Two rules shape this file:
 *
 * 1. **The source text stays authoritative.** Translations are a projection (AGENTS_MASTER invariant 1).
 *    Nothing here writes to a domain table, and `content_translations` is keyed by a hash of the source, so
 *    an edited listing can never be shown with its old translation.
 * 2. **A read never waits for a model.** `translateMany` answers from the cache only. Misses are queued and
 *    filled in the background, so the first reader of a new listing sees the original text and everyone after
 *    them sees their own language. A public GET must not inherit the latency or the failure modes of an
 *    external API.
 *
 * Without a translator adapter registered (no `ANTHROPIC_API_KEY`), every call is a no-op that returns the
 * source text — the feature degrades to exactly today's behaviour rather than erroring.
 */

/** Provider contract. Implemented by the Claude adapter in modules/ai; injectable in tests. */
export interface Translator {
  readonly provider: string;
  readonly model: string;
  /** Translate `texts` into `targetLocale`. Must return one entry per input, in order. */
  translate(texts: string[], targetLocale: string): Promise<string[]>;
}

export const sourceHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Content worth sending to a model: non-empty, not a bare number/code, and short enough to be copy. */
export function translatable(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length > 1 && t.length <= 20_000 && /\p{L}/u.test(t);
}

export interface TranslateDeps {
  db: Db;
  translator?: Translator;
  /** Fire-and-forget filler; omitted in tests that only exercise the cache. */
  queue?: (texts: string[], targetLocale: string) => void;
}

/**
 * Cached translations for `texts` into `targetLocale`, as a Map keyed by the **source** string.
 * Texts without a cached translation are absent from the map (callers keep the original) and queued.
 */
export async function translateMany(deps: TranslateDeps, texts: readonly string[], targetLocale: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(texts.filter(translatable))];
  if (!unique.length) return out;

  const byHash = new Map(unique.map((t) => [sourceHash(t), t]));
  const rows = await deps.db.query(
    `SELECT source_hash, translated FROM content_translations WHERE target_locale = $1 AND source_hash = ANY($2::char(64)[])`,
    [targetLocale, [...byHash.keys()]],
  );
  for (const r of rows.rows) {
    const src = byHash.get(r.source_hash);
    if (src) out.set(src, r.translated);
  }

  const missing = unique.filter((t) => !out.has(t));
  if (missing.length && deps.translator && deps.queue) deps.queue(missing, targetLocale);
  return out;
}

/** Translate `fields` of `obj` in place-ish, returning a copy. Unknown/absent translations keep the source. */
export function applyTranslations<T extends Record<string, any>>(obj: T, fields: readonly string[], map: Map<string, string>): T {
  if (!map.size) return obj;
  let changed = false;
  const next: Record<string, any> = { ...obj };
  for (const f of fields) {
    const v = obj[f];
    if (typeof v !== 'string') continue;
    const t = map.get(v);
    if (t && t !== v) {
      next[f] = t;
      changed = true;
    }
  }
  return changed ? (next as T) : obj;
}

/** Collect the translatable strings at `fields` across `rows` (for one batched cache lookup). */
export function collect(rows: readonly any[], fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r) continue;
    for (const f of fields) if (translatable(r[f])) out.push(r[f]);
  }
  return out;
}

/** Persist a batch. Conflicts are ignored: two readers racing on the same text is normal and harmless. */
export async function storeTranslations(
  db: Db,
  entries: ReadonlyArray<{ source: string; translated: string }>,
  targetLocale: string,
  provider: string,
  model: string,
): Promise<number> {
  const usable = entries.filter((e) => translatable(e.source) && e.translated?.trim() && e.translated !== e.source);
  if (!usable.length) return 0;
  const res = await db.query(
    `INSERT INTO content_translations(source_hash, target_locale, translated, provider, model)
     SELECT * FROM unnest($1::char(64)[], $2::text[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (source_hash, target_locale) DO NOTHING`,
    [
      usable.map((e) => sourceHash(e.source)),
      usable.map(() => targetLocale),
      usable.map((e) => e.translated.slice(0, 20_000)),
      usable.map(() => provider),
      usable.map(() => model),
    ],
  );
  return res.rowCount ?? 0;
}
