/**
 * Supported UI languages. Korean is the source language; English is the pivot every other language falls back
 * to (see lib/phrases.ts). `Lang` itself lives in lib/format.ts because the formatters are its oldest consumer.
 */
import type { Lang } from './format';

export interface LangInfo {
  /** Our short code, also the `jp_lang` cookie / localStorage value. */
  code: Lang;
  /** BCP-47 tag handed to `Intl.*` and written to `<html lang>`. */
  locale: string;
  /** The language's own name, which is what a speaker looks for in a picker. */
  endonym: string;
  /** English name, for `aria-label`s and the preferences screen. */
  english: string;
}

export const LANGS: readonly LangInfo[] = [
  { code: 'ko', locale: 'ko-KR', endonym: '한국어', english: 'Korean' },
  { code: 'en', locale: 'en-US', endonym: 'English', english: 'English' },
  { code: 'ja', locale: 'ja-JP', endonym: '日本語', english: 'Japanese' },
  { code: 'zh', locale: 'zh-CN', endonym: '简体中文', english: 'Chinese (Simplified)' },
  { code: 'vi', locale: 'vi-VN', endonym: 'Tiếng Việt', english: 'Vietnamese' },
] as const;

export const LANG_CODES = LANGS.map((l) => l.code);

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANG_CODES as string[]).includes(v);

export const langInfo = (l: Lang): LangInfo => LANGS.find((x) => x.code === l) ?? LANGS[0];

/**
 * Best supported language for a list of browser tags (`navigator.languages`, or an `Accept-Language` list).
 * Matches the primary subtag, so `en-GB` picks English and `zh-Hant-TW` still picks Chinese. Returns null when
 * nothing matches, which lets the caller keep its own default rather than silently switching to Korean.
 */
export function pickLang(tags: readonly string[] | undefined): Lang | null {
  for (const tag of tags ?? []) {
    const primary = String(tag).toLowerCase().split('-')[0];
    // `zh-TW`/`zh-HK` are Traditional; we only ship Simplified, which is still far better than English for them.
    const hit = LANGS.find((l) => l.code === primary);
    if (hit) return hit.code;
  }
  return null;
}
