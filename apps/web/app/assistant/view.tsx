'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { arr, item, str } from '@/lib/shape';
import { ApiError } from '@/lib/errors';
import { RequireAuth } from '@/components/gate';
import { Alert, ErrorText, PageHeader } from '@/components/ui';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  links?: Array<{ label: string; href: string }>;
}

/** AI travel assistant (AI-01). Advisory only: it never books or pays; suggestions link to real listings. */
export default function AssistantView() {
  const { L, lang } = useI18n();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const conv = useRef<string>('');
  return (
    <RequireAuth>
      <PageHeader title={L('AI 여행 도우미', 'AI travel assistant')} subtitle={L('일정·지역·예산을 알려주시면 JETPOOL 숙소·가이드·상품을 찾아드려요. AI 답변은 참고용이며 예약·결제는 직접 확인 후 진행됩니다.', 'Advisory only — bookings and payments are always confirmed by you and our servers.')} />
      {err instanceof ApiError && err.kind === 'disabled' ? (
        <Alert tone="info">{L('AI 도우미는 아직 준비 중입니다.', 'The assistant is not yet available.')}</Alert>
      ) : (
        <div className="stack">
          <div className="thread" aria-live="polite" style={{ minHeight: 240 }}>
            {msgs.length === 0 && <p className="muted center">{L('예: “11월에 제주 한달살기, 2인, 월 200만원 이내”', 'e.g. “A month in Jeju in November for two under ₩2M”')}</p>}
            {msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.role === 'user' ? 'me' : ''}`}>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.text}</p>
                {m.links?.map((l) => (
                  <Link key={l.href} href={l.href} className="small" style={{ display: 'block' }}>
                    → {l.label}
                  </Link>
                ))}
              </div>
            ))}
            {busy && <div className="bubble"><span className="muted">…</span></div>}
          </div>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              const q = text.trim();
              setText('');
              setMsgs((m) => [...m, { role: 'user', text: q }]);
              setBusy(true);
              setErr(null);
              try {
                const res = await post('/v1/ai/travel-assistant', { message: q, conversationId: conv.current || undefined, locale: lang === 'ko' ? 'ko-KR' : 'en-US', history: msgs.slice(-8).map((m) => ({ role: m.role, content: m.text })) });
                const r = item(res);
                conv.current = str(r, 'conversationId') || conv.current;
                const links = arr(r, 'suggestions', 'items', 'results').map((s: any) => {
                  const t = str(s, 'type', 'targetType').toUpperCase();
                  const id = str(s, 'slug', 'id', 'targetId');
                  const href = t === 'GUIDE' ? `/guides/${id}` : t === 'TRAVEL_PRODUCT' || t === 'PRODUCT' ? `/travel/${id}` : `/stay/${id}`;
                  return { label: str(s, 'title', 'name') || id, href };
                });
                setMsgs((m) => [...m, { role: 'assistant', text: str(r, 'reply', 'answer', 'message', 'text'), links }]);
              } catch (x) {
                setErr(x);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="sr-only" htmlFor="ask">{L('질문', 'Message')}</label>
            <input id="ask" className="grow" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={L('무엇이든 물어보세요', 'Ask anything')} />
            <button className="btn primary" disabled={busy}>{L('보내기', 'Send')}</button>
          </form>
          <ErrorText error={err} />
        </div>
      )}
    </RequireAuth>
  );
}
