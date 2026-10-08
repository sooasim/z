'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon, type IconName } from '@/components/ui';
import s from './public.module.css';

export interface Benefit {
  icon: IconName;
  title: string;
  body: string;
}

/**
 * Logged-out value-prop panel for member features (assistant, planner, exchange): what you get, a preview and both
 * "로그인" and "회원가입" with `next` set to the current page.
 */
export function AuthTeaser({ title, lead, benefits, preview, note }: { title: string; lead: string; benefits: Benefit[]; preview?: ReactNode; note?: ReactNode }) {
  const { t } = useI18n();
  const path = usePathname() || '/';
  const sp = useSearchParams();
  const qs = sp?.toString();
  const next = encodeURIComponent(qs ? `${path}?${qs}` : path);
  return (
    <section className={s.teaser} aria-labelledby="teaser-h">
      <div>
        <h2 id="teaser-h">{title}</h2>
        <p className="muted" style={{ margin: 0 }}>{lead}</p>
        <ul className={s.benefits}>
          {benefits.map((b) => (
            <li key={b.title}>
              <span className={s.icoTile} aria-hidden="true">
                <Icon name={b.icon} size={20} />
              </span>
              <span>
                <strong>{b.title}</strong>
                <span className="small muted" style={{ display: 'block' }}>{b.body}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 'var(--sp-6)' }}>
          <Link className="btn primary lg" href={`/signup?next=${next}`}>
            {t('nav.signup')}
          </Link>
          <Link className="btn lg" href={`/login?next=${next}`}>
            {t('nav.login')}
          </Link>
        </div>
        {note && <p className="xs muted" style={{ margin: 'var(--sp-3) 0 0' }}>{note}</p>}
      </div>
      {preview && (
        <div className={s.preview} aria-hidden="true">
          {preview}
        </div>
      )}
    </section>
  );
}
