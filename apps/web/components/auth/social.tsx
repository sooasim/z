'use client';
import { useI18n } from '@/lib/i18n';

const PROVIDERS = [
  { id: 'google', ko: 'Google로 계속하기', en: 'Continue with Google', bg: '#ffffff', fg: '#1f1f1f', border: '#747775' },
  { id: 'kakao', ko: '카카오로 계속하기', en: 'Continue with Kakao', bg: '#FEE500', fg: '#191919', border: '#FEE500' },
  { id: 'naver', ko: '네이버로 계속하기', en: 'Continue with Naver', bg: '#03A94D', fg: '#ffffff', border: '#03A94D' },
];

/** Plain-text provider buttons (no trademarked logos). Start goes through the BFF → /v1/auth/oauth/:provider/start. */
export function SocialButtons({ next }: { next?: string }) {
  const { lang } = useI18n();
  return (
    <div className="stack">
      {PROVIDERS.map((p) => (
        <a
          key={p.id}
          className="btn block"
          style={{ background: p.bg, color: p.fg, borderColor: p.border }}
          href={`/api/auth/oauth/${p.id}/start`}
          onClick={() => {
            try {
              if (next) sessionStorage.setItem('jp_next', next);
            } catch {
              /* ignore */
            }
          }}
        >
          {p[lang]}
        </a>
      ))}
    </div>
  );
}

export function safeNext(n: string | null | undefined): string {
  if (!n || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/api/')) return '/';
  return n;
}
