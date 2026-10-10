import type { FastifyRequest } from 'fastify';
import type { AppContext, Ctx } from './context.js';
import { isEnabled } from './flags.js';
import { applyTranslations, collect, translatable, translateMany, type TranslateDeps, type Translator } from './translate.js';
import { TranslationQueue } from './translate-queue.js';
import { ClaudeTranslator } from '../modules/ai/translator.js';

/** UI languages the product ships. A request for anything else is served in the source language. */
export const SUPPORTED_LOCALES = ['ko-KR', 'en-US', 'ja-JP', 'zh-CN', 'vi-VN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Korean is the source language of the catalogue: asking for it means "no translation". */
export const SOURCE_LOCALE: SupportedLocale = 'ko-KR';

const byPrimary = new Map<string, SupportedLocale>(SUPPORTED_LOCALES.map((l) => [l.split('-')[0], l]));

/**
 * The locale to render member-written content in: an explicit `?locale=`, else `Accept-Language`, else the
 * source language. Matching is on the primary subtag, so `en-GB` reads English and `zh-Hant-TW` reads
 * Simplified Chinese — the same rule the web client uses (apps/web/lib/langs.ts).
 */
export function contentLocale(req: Pick<FastifyRequest, 'headers'> & { query?: unknown }): SupportedLocale {
  const explicit = (req.query as { locale?: unknown } | undefined)?.locale;
  const direct = match(typeof explicit === 'string' ? explicit : undefined);
  if (direct) return direct;
  const header = req.headers['accept-language'];
  if (typeof header === 'string') {
    // "ja,en-US;q=0.9,en;q=0.8" — honour the order the browser gave, ignore the weights.
    for (const part of header.split(',')) {
      const hit = match(part.split(';')[0]?.trim());
      if (hit) return hit;
    }
  }
  return SOURCE_LOCALE;
}

const match = (tag?: string): SupportedLocale | null => {
  if (!tag) return null;
  const primary = tag.toLowerCase().split('-')[0];
  return byPrimary.get(primary) ?? null;
};

/** The configured translator, or null when no provider is set up (the feature then no-ops). */
export function getTranslator(app: AppContext): Translator | null {
  const injected = app.adapters.get('i18n.translator') as Translator | undefined;
  if (injected) return injected;
  if (!app.config.ANTHROPIC_API_KEY) return null;
  const t = new ClaudeTranslator(app.config.ANTHROPIC_API_KEY, app.config.AI_MODEL);
  app.adapters.set('i18n.translator', t);
  return t;
}

function getQueue(app: AppContext, translator: Translator): TranslationQueue {
  let q = app.adapters.get('i18n.translateQueue') as TranslationQueue | undefined;
  if (!q) {
    q = new TranslationQueue(app, translator);
    app.adapters.set('i18n.translateQueue', q);
  }
  return q;
}

/**
 * Build the dependencies for `translateMany` for this request, or null when nothing should be translated —
 * the reader wants the source language, or the `content.auto_translate` flag is off.
 *
 * Returning null (rather than an empty map) lets callers skip the cache round-trip entirely on the Korean
 * path, which is the majority of traffic.
 */
export async function contentTranslation(ctx: Ctx, locale: SupportedLocale): Promise<TranslateDeps | null> {
  if (locale === SOURCE_LOCALE) return null;
  if (!(await isEnabled(ctx.app.pool, 'content.auto_translate', ctx.actor ? { userId: ctx.actor.userId, roles: ctx.actor.roles } : undefined))) return null;
  const translator = getTranslator(ctx.app);
  // Without a provider the cache may still hold translations from a warm-up run, so keep reading it.
  return {
    db: ctx.app.pool,
    translator: translator ?? undefined,
    queue: translator ? (texts, target) => getQueue(ctx.app, translator).add(texts, target) : undefined,
  };
}

/**
 * Translate `fields` across `rows` in one cache lookup. Rows keep their source text where no translation is
 * cached yet; the misses are queued so the next reader gets them.
 */
export async function localizeRows<T extends Record<string, any>>(
  deps: TranslateDeps | null,
  rows: T[],
  fields: readonly string[],
  locale: string,
): Promise<T[]> {
  if (!deps || !rows.length) return rows;
  const map = await translateMany(deps, collect(rows, fields), locale);
  return map.size ? rows.map((r) => applyTranslations(r, fields, map)) : rows;
}

/**
 * Translate a DTO tree in one cache lookup. `paths` are dotted, with `[]` to walk an array:
 * `['title', 'houseRules.extraRules', 'host.about', 'items[].title']`.
 *
 * Keeping the field list at the call site means platform/ holds no knowledge of any module's DTO shape, while
 * each route still localizes its whole response with a single round-trip.
 *
 * Rewrites `root` in place and returns it. That is safe because callers pass a DTO they just built for this
 * one response; never hand it a cached or shared object.
 */
export async function localize<T>(deps: TranslateDeps | null, root: T, paths: readonly string[], locale: string): Promise<T> {
  if (!deps || !root) return root;
  const slots = paths.flatMap((p) => resolveSlots(root, p));
  const sources = slots.map((s) => s.value);
  if (!sources.length) return root;
  const map = await translateMany(deps, sources, locale);
  if (!map.size) return root;
  for (const s of slots) {
    const t = map.get(s.value);
    if (t) s.parent[s.key] = t;
  }
  return root;
}

/** Every `{ parent, key, value }` a dotted path points at, skipping anything not worth translating. */
function resolveSlots(root: any, path: string): Array<{ parent: any; key: string; value: string }> {
  let nodes: any[] = [root];
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const arrayStep = parts[i].endsWith('[]');
    const key = arrayStep ? parts[i].slice(0, -2) : parts[i];
    const next: any[] = [];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      if (isLast && !arrayStep) {
        if (typeof n[key] === 'string') next.push({ parent: n, key, value: n[key] });
        continue;
      }
      const v = n[key];
      if (arrayStep && Array.isArray(v)) next.push(...v);
      else if (!arrayStep && v) next.push(v);
    }
    nodes = next;
  }
  return (nodes as Array<{ parent: any; key: string; value: string }>).filter((s) => s && translatable(s.value));
}
