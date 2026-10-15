'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { AuthProvider, useAuth } from '@/lib/auth';
import { patch } from '@/lib/api';
import { langInfo } from '@/lib/langs';
import type { Lang } from '@/lib/format';
import { ToastProvider } from './ui/toast';
import { FavoritesProvider } from './favorites';

/**
 * Keep `users.locale` in step with the language the member is actually reading in.
 *
 * The picker itself is per-device (cookie + localStorage), which is right for the UI. But work that happens
 * when nobody is looking — translating an incoming message into each member's language, notification copy,
 * email — runs in a background job with no request and no cookie, so it can only read the account. Without
 * this, every member looks Korean to that job and a Vietnamese traveller is never translated for.
 *
 * Fire-and-forget: a failure here costs nothing the next page load will not retry, so it is never surfaced.
 */
function LanguageSync() {
  const { lang } = useI18n();
  const { user, ready } = useAuth();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !user) return;
    const locale = langInfo(lang).locale;
    if (user.locale === locale || sent.current === locale) return;
    sent.current = locale;
    patch('/v1/me/profile', { locale }).catch(() => {
      sent.current = null; // let the next render try again
    });
  }, [lang, ready, user]);
  return null;
}

export function Providers({ children, lang }: { children: ReactNode; lang: Lang }) {
  return (
    <I18nProvider initial={lang}>
      <ToastProvider>
        <AuthProvider>
          <LanguageSync />
          <FavoritesProvider>{children}</FavoritesProvider>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
