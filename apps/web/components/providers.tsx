'use client';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { AuthProvider } from '@/lib/auth';
import type { Lang } from '@/lib/format';

export function Providers({ children, lang }: { children: ReactNode; lang: Lang }) {
  return (
    <I18nProvider initial={lang}>
      <AuthProvider>{children}</AuthProvider>
    </I18nProvider>
  );
}
