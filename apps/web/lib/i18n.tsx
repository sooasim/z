'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DICT, type DictKey } from './dict';
import { isLang, langInfo, pickLang } from './langs';
import { translate } from './phrases';
import type { Lang } from './format';

const STORAGE_KEY = 'jp_lang';

interface I18n {
  lang: Lang;
  /** Pass `null` to clear the explicit choice and follow the browser again. */
  setLang: (l: Lang | null) => void;
  /** True while the language comes from the browser rather than an explicit choice. */
  auto: boolean;
  t: (k: DictKey) => string;
  /**
   * Inline bilingual string: `L('검색', 'Search')`. Korean renders the first argument; every other language
   * renders the second, translated by source string via lib/phrases.ts when a translation exists.
   */
  L: (ko: string, en: string) => string;
  /** Translate an English string that came from data rather than a literal (status labels, enum labels). */
  tr: (en: string) => string;
}

const noop: I18n = {
  lang: 'ko',
  setLang: () => {},
  auto: false,
  t: (k) => DICT.ko[k],
  L: (ko) => ko,
  tr: (en) => en,
};
const Ctx = createContext<I18n>(noop);

/** Explicit choice from a previous visit. Cookie first so a server render can read the same value. */
function storedLang(): Lang | null {
  try {
    const cookie = document.cookie.match(/(?:^|;\s*)jp_lang=([^;]+)/)?.[1];
    if (isLang(cookie)) return cookie;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* storage or cookies blocked — fall through to the browser language */
  }
  return null;
}

const fromBrowser = (): Lang | null =>
  pickLang(typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]));

export function I18nProvider({ children, initial = 'ko' }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const [auto, setAuto] = useState(false);

  // Resolve after mount, never during render: the server/static HTML is Korean, so reading the browser here is
  // what keeps the markup hydration-stable.
  useEffect(() => {
    const explicit = storedLang();
    if (explicit) {
      setLangState(explicit);
      setAuto(false);
      return;
    }
    setAuto(true);
    const detected = fromBrowser();
    if (detected) setLangState(detected);
  }, []);

  useEffect(() => {
    document.documentElement.lang = langInfo(lang).locale;
  }, [lang]);

  const setLang = useCallback((l: Lang | null) => {
    if (l === null) {
      setAuto(true);
      try {
        localStorage.removeItem(STORAGE_KEY);
        document.cookie = 'jp_lang=; path=/; max-age=0; samesite=lax';
      } catch {
        /* ignore */
      }
      setLangState(fromBrowser() ?? 'ko');
      return;
    }
    setLangState(l);
    setAuto(false);
    try {
      localStorage.setItem(STORAGE_KEY, l);
      document.cookie = `jp_lang=${l}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      auto,
      t: (k) => DICT[lang]?.[k] ?? DICT.en[k] ?? DICT.ko[k] ?? k,
      L: (ko, en) => (lang === 'ko' ? ko : translate(en, lang)),
      tr: (en) => translate(en, lang),
    }),
    [lang, auto, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
