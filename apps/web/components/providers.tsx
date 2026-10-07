'use client';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { AuthProvider } from '@/lib/auth';
import type { Lang } from '@/lib/format';
import { ToastProvider } from './ui/toast';
import { FavoritesProvider } from './favorites';

export function Providers({ children, lang }: { children: ReactNode; lang: Lang }) {
  return (
    <I18nProvider initial={lang}>
      <ToastProvider>
        <AuthProvider>
          <FavoritesProvider>{children}</FavoritesProvider>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
