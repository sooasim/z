'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DICT, type DictKey } from './dict';
import type { Lang } from './format';

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: DictKey) => string;
  /** Inline bilingual string: L('검색', 'Search'). */
  L: (ko: string, en: string) => string;
}

const Ctx = createContext<I18n>({ lang: 'ko', setLang: () => {}, t: (k) => DICT.ko[k], L: (ko) => ko });

export function I18nProvider({ children, initial = 'ko' }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('jp_lang');
      if (saved === 'en' || saved === 'ko') setLangState(saved);
    } catch {
      /* storage blocked */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === 'ko' ? 'ko-KR' : 'en';
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('jp_lang', l);
      document.cookie = `jp_lang=${l}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo<I18n>(
    () => ({ lang, setLang, t: (k) => DICT[lang][k] ?? DICT.ko[k] ?? k, L: (ko, en) => (lang === 'ko' ? ko : en) }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
