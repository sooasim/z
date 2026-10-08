'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon, Illustration } from '@/components/ui';

/** Route error boundary: friendly, localized, with retry + ways out (home, help centre). */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { L } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="state" role="alert" style={{ maxWidth: 720, margin: '24px auto' }}>
      <Illustration name="error" />
      <h1>{L('페이지를 표시하는 중 문제가 생겼어요', 'Something went wrong on this page')}</h1>
      <p className="muted">{L('일시적인 문제일 수 있어요. 다시 시도해도 계속되면 고객센터에 알려 주세요. 입력하던 내용은 저장되지 않았을 수 있어요.', 'It may be temporary. If it keeps happening, let our help centre know. Anything you were typing may not have been saved.')}</p>
      {error.digest && <p className="mono small subtle">{L('오류 코드', 'Error ref')}: {error.digest}</p>}
      <div className="actions">
        <button type="button" className="btn primary" onClick={reset}>
          <Icon name="refresh" size={16} /> {L('다시 시도', 'Try again')}
        </button>
        <Link className="btn" href="/">
          <Icon name="home" size={16} /> {L('홈으로', 'Go home')}
        </Link>
        <Link className="btn ghost" href={`/support${error.digest ? `?ref=${encodeURIComponent(error.digest)}` : ''}`}>
          <Icon name="support" size={16} /> {L('고객센터', 'Help centre')}
        </Link>
      </div>
    </div>
  );
}
