'use client';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { LoginLink } from './states';
import { Spinner } from './ui';
import Link from 'next/link';

/** Client-side route gate (UX only — the API enforces authorization on every request). */
export function RequireAuth({ roles, children, staff }: { roles?: string[]; staff?: boolean; children: ReactNode }) {
  const { ready, user, hasRole, isStaff } = useAuth();
  const { t, L } = useI18n();
  if (!ready) return <Spinner />;
  if (!user)
    return (
      <div className="state" role="alert">
        <h2>401 · {t('state.unauth')}</h2>
        <LoginLink />
      </div>
    );
  if ((staff && !isStaff) || (roles && roles.length && !hasRole(...roles, 'ADMIN')))
    return (
      <div className="state" role="alert">
        <h2>403 · {t('state.forbidden')}</h2>
        <p className="muted">
          {L('필요 권한', 'Required role')}: {staff ? 'STAFF' : roles?.join(' / ')}
        </p>
        {roles?.includes('HOST') && <Link href="/host/onboarding">{L('호스트 신청하기', 'Become a host')}</Link>}
        {roles?.includes('GUIDE') && <Link href="/guide/onboarding">{L('가이드 등록하기', 'Become a guide')}</Link>}
      </div>
    );
  return <>{children}</>;
}
