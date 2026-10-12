import TABLE from '../../../data/translations/demo.json';

/**
 * Client-side mirror of the API's content translation (apps/api/src/platform/translate.ts).
 *
 * On the server, member-written copy is translated by looking the **source string** up in a cache and
 * swapping it for the reader's language. The static demo has no server: it replays responses recorded in
 * Korean, so the same swap has to happen here or the demo could never show the feature.
 *
 * It uses the very same table the database is seeded from (`data/translations/demo.json`), keyed the same
 * way — by the exact source string — so what the demo shows is what the API would return once its cache is
 * warm. A string with no entry stays in Korean, which is also the server's behaviour.
 *
 * Matching is whole-string, not substring: these keys are distinctive listing titles and summaries, so a
 * blind walk of the response body cannot corrupt an id, a slug, an enum or a date.
 */
type Table = Record<string, Record<string, string>>;

const byLocale: Table = {};
for (const [key, entries] of Object.entries(TABLE as Record<string, unknown>)) {
  if (key.startsWith('_') || !entries || typeof entries !== 'object') continue;
  const locale = key.split('→').pop()?.trim();
  if (locale) byLocale[locale] = entries as Record<string, string>;
}

export const demoLocales = Object.keys(byLocale);

/** Deep-copy-free: rewrites the body in place, which is safe because every response body is already a clone. */
export function translateBody<T>(body: T, locale: string | null | undefined): T {
  const table = locale ? byLocale[locale] : undefined;
  if (!table) return body;
  const walk = (v: any): any => {
    if (typeof v === 'string') return table[v] ?? v;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
      return v;
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = walk(v[k]);
      return v;
    }
    return v;
  };
  return walk(body);
}

/**
 * The reader's locale, from the same `jp_lang` cookie/localStorage the web app writes. Read per response
 * rather than cached, so switching language takes effect without a reload.
 */
export function readerLocale(): string | null {
  const TAGS: Record<string, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', vi: 'vi-VN' };
  try {
    const code = document.cookie.match(/(?:^|;\s*)jp_lang=([^;]+)/)?.[1] ?? localStorage.getItem('jp_lang') ?? '';
    return TAGS[code] ?? null;
  } catch {
    return null;
  }
}
