'use client';
import { useEffect, useState } from 'react';

/**
 * Last-resort boundary for errors in the root layout / providers. It replaces the whole document, so it carries its
 * own <html>/<body> and inline styles (globals.css and the i18n provider may not be available).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [en, setEn] = useState(false);
  useEffect(() => {
    console.error(error);
    try {
      setEn(localStorage.getItem('jp_lang') === 'en' || /(?:^|;\s*)jp_lang=en/.test(document.cookie));
    } catch {
      /* storage blocked */
    }
  }, [error]);
  const L = (ko: string, e: string) => (en ? e : ko);
  const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, padding: '0 18px', borderRadius: 12, fontWeight: 700, fontSize: 14, textDecoration: 'none', cursor: 'pointer', font: 'inherit' };
  return (
    <html lang={en ? 'en' : 'ko-KR'}>
      <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16, background: '#fbf8f3', color: '#14233a', fontFamily: "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif" }}>
        <main style={{ maxWidth: 520, width: '100%', textAlign: 'center', background: '#fff', border: '1px solid #e4e0d8', borderRadius: 24, padding: '40px 24px', boxShadow: '0 6px 16px rgba(14,42,71,.1)' }}>
          <div aria-hidden="true" style={{ fontWeight: 900, letterSpacing: '0.18em', fontSize: 18, marginBottom: 20 }}>
            <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: '#d94a33', marginRight: 8, verticalAlign: 1 }} />
            JETPOOL
          </div>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>{L('일시적인 문제가 생겼어요', 'Something went wrong')}</h1>
          <p style={{ color: '#55657a', margin: '0 0 20px', lineHeight: 1.6 }}>{L('잠시 후 다시 시도해 주세요. 문제가 계속되면 고객센터로 알려 주세요.', 'Please try again in a moment. If it keeps happening, contact our help centre.')}</p>
          {error.digest && <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#5f6e82', margin: '0 0 20px' }}>ref: {error.digest}</p>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={reset} style={{ ...btn, background: '#0e2a47', color: '#fff', border: '1px solid #0e2a47' }}>
              {L('다시 시도', 'Try again')}
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload: the app shell itself failed */}
            <a href="/" style={{ ...btn, background: '#fff', color: '#14233a', border: '1px solid #c9c1b3' }}>
              {L('홈으로', 'Go home')}
            </a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/support" style={{ ...btn, background: 'transparent', color: '#1f4e7a', border: '1px solid transparent' }}>
              {L('고객센터', 'Help centre')}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
