'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { LoginLink } from './states';
import { ListSkeleton } from './ui/skeleton';
import { Illustration } from './ui/illustrations';
import { pickPair } from '@/lib/phrases';

const ROLE_LABEL: Record<string, [string, string]> = {
  HOST: ['호스트', 'Host'],
  GUIDE: ['가이드', 'Guide'],
  SUPPLIER: ['여행 공급사', 'Travel supplier'],
  ADMIN: ['관리자', 'Admin'],
  SUPPORT: ['고객지원 담당자', 'Support agent'],
  ACCOUNTING: ['회계 담당자', 'Accounting'],
  COMPLIANCE: ['컴플라이언스 담당자', 'Compliance'],
  EDITOR: ['콘텐츠 에디터', 'Editor'],
  STAFF: ['운영진', 'Staff'],
};

/** Next step per missing role (where a member can apply for it). */
const ROLE_CTA: Record<string, { href: string; ko: string; en: string }> = {
  HOST: { href: '/host/onboarding', ko: '호스트 신청하기', en: 'Become a host' },
  GUIDE: { href: '/guide/onboarding', ko: '가이드 등록하기', en: 'Become a guide' },
  SUPPLIER: { href: '/support?topic=supplier', ko: '여행 공급사 입점 문의', en: 'Apply as a supplier' },
};

/** Client-side route gate (UX only — the API enforces authorization on every request). */
export function RequireAuth({ roles, children, staff }: { roles?: string[]; staff?: boolean; children: ReactNode }) {
  const { ready, user, hasRole, isStaff } = useAuth();
  const { t, L, lang } = useI18n();
  if (!ready) return <ListSkeleton rows={3} />;
  if (!user)
    return (
      <div className="state" role="alert">
        <Illustration name="lock" />
        <h1>{t('state.unauth')}</h1>
        <p className="muted">{L('로그인하면 이 페이지를 이용할 수 있어요.', 'Sign in to continue.')}</p>
        <div className="actions">
          <LoginLink />
          <Link className="btn ghost" href="/signup">
            {t('nav.signup')}
          </Link>
        </div>
      </div>
    );
  if ((staff && !isStaff) || (roles && roles.length && !hasRole(...roles, 'ADMIN'))) {
    const needed = staff ? ['STAFF'] : roles ?? [];
    const names = needed.map((r) => pickPair(ROLE_LABEL[r], lang) ?? r).join(lang === 'ko' ? ' 또는 ' : ' or ');
    const ctas = needed.map((r) => ROLE_CTA[r]).filter(Boolean);
    return (
      <div className="state" role="alert">
        <Illustration name="lock" />
        <h1>{staff ? L('운영진 전용 페이지입니다', 'Staff only') : L(`${names} 전용 페이지입니다`, `${names} only`)}</h1>
        <p className="muted">
          {staff
            ? L('관리자 권한이 있는 계정으로 로그인해 주세요.', 'Sign in with a staff account.')
            : L(`이 페이지는 ${names} 계정에서 이용할 수 있어요.${ctas.length ? ' 지금 신청하면 심사 후 바로 시작할 수 있어요.' : ''}`, `This page is for ${names} accounts.${ctas.length ? ' Apply now and start once approved.' : ''}`)}
        </p>
        <div className="actions">
          {ctas.map((c, i) => (
            <Link key={c.href} className={`btn ${i === 0 ? 'primary' : ''}`} href={c.href}>
              {lang === 'ko' ? c.ko : c.en}
            </Link>
          ))}
          <Link className="btn ghost" href="/">
            {L('홈으로', 'Go home')}
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
