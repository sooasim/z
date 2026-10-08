'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import s from './public.module.css';

export interface Crumb {
  href?: string;
  label: string;
}

/** Breadcrumb trail for detail pages: 홈 › 숙소 › 제주 › 한림 돌담 독채. The last item is the current page. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const { L } = useI18n();
  const all: Crumb[] = [{ href: '/', label: L('홈', 'Home') }, ...items.filter((c) => c.label)];
  return (
    <nav aria-label={L('현재 위치', 'Breadcrumb')} className={s.crumbs}>
      <ol>
        {all.map((c, i) => {
          const last = i === all.length - 1;
          return (
            <li key={`${c.label}-${i}`}>
              {last || !c.href ? <span aria-current={last ? 'page' : undefined}>{c.label}</span> : <Link href={c.href}>{c.label}</Link>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
