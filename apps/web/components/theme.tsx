'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from './ui/icons';

export type ThemePref = 'light' | 'dark' | 'system';

/** Inline (pre-paint) script: applies the stored theme to <html data-theme> to avoid a flash. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('jp_theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}var l=localStorage.getItem('jp_lang');if(l==='en'){document.documentElement.lang='en'}}catch(e){}})();`;

export function applyTheme(t: ThemePref) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem('jp_theme');
    else localStorage.setItem('jp_theme', t);
  } catch {
    /* ignore */
  }
}

export function ThemeToggle() {
  const { L } = useI18n();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    setDark(attr ? attr === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);
  return (
    <button
      type="button"
      className="btn ghost icon sm theme-toggle"
      aria-label={dark ? L('라이트 모드로 전환', 'Switch to light mode') : L('다크 모드로 전환', 'Switch to dark mode')}
      aria-pressed={dark}
      onClick={() => {
        applyTheme(dark ? 'light' : 'dark');
        setDark(!dark);
      }}
    >
      <Icon name={dark ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
