'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { arr, item, num, str } from '@/lib/shape';
import { formatMoney } from '@/lib/format';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { ApiError } from '@/lib/errors';
import { RequireAuth } from '@/components/gate';
import { EmptyState } from '@/components/states';
import { Button, ButtonLink, ErrorText, Icon, PageHeader } from '@/components/ui';
import { AuthTeaser } from '@/components/public/AuthTeaser';
import s from '@/components/public/public.module.css';

interface Suggestion {
  href: string;
  title: string;
  meta: string;
  price?: string;
  reason?: string;
  img: string;
  kind: string;
}
interface Msg {
  role: 'user' | 'assistant';
  text: string;
  suggestions?: Suggestion[];
}

const UNIT: Record<string, [string, string]> = { NIGHT: ['박', 'night'], HOUR: ['시간', 'hr'], PERSON: ['1인', 'person'] };
const KIND: Record<string, [string, string]> = { PROPERTY: ['숙소', 'Stay'], GUIDE: ['가이드', 'Guide'], TRAVEL_PRODUCT: ['투어', 'Tour'] };

function useExamples() {
  const { L } = useI18n();
  return [
    L('11월에 제주 한달살기, 2인, 월 200만원 이내', 'A month in Jeju in November for two, under ₩2M'),
    L('강릉에서 바다 보며 일할 수 있는 숙소와 커피 투어', 'A seaside workation stay in Gangneung plus a coffee tour'),
    L('서울에서 한국어로 동네를 소개해 줄 무료 가이드 프렌드', 'A free local friend to show me around Seoul'),
  ];
}

function Chat() {
  const { L, lang } = useI18n();
  const examples = useExamples();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const conv = useRef<string>('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [msgs, busy]);
  const send = async (q: string) => {
    if (!q.trim() || busy) return;
    setText('');
    setMsgs((m) => [...m, { role: 'user', text: q.trim() }]);
    setBusy(true);
    setErr(null);
    try {
      const res = await post('/v1/ai/travel-assistant', { message: q.trim(), sessionId: conv.current || undefined });
      const r = item(res);
      conv.current = str(r, 'sessionId') || conv.current;
      const suggestions: Suggestion[] = arr(r, 'suggestions').map((x: any) => {
        const t = str(x, 'type').toUpperCase();
        const id = str(x, 'id');
        const city = str(x, 'city');
        const price = num(x, 'price.amountMinor');
        const unit = UNIT[str(x, 'price.unit').toUpperCase()];
        return {
          href: str(x, 'action.href') || (t === 'GUIDE' ? `/guides/${id}` : t === 'TRAVEL_PRODUCT' ? `/travel/${id}` : `/stay/${id}`),
          title: str(x, 'title'),
          meta: [KIND[t] ? KIND[t][lang === 'ko' ? 0 : 1] : '', placeLabel(city, lang)].filter(Boolean).join(' · '),
          price: price !== undefined ? `${formatMoney(price, str(x, 'price.currency') || 'KRW', lang)}${unit ? ` / ${unit[lang === 'ko' ? 0 : 1]}` : ''}` : undefined,
          reason: lang === 'ko' ? arr<string>(x, 'reasons')[0] : undefined,
          img: postcardFor(city || str(x, 'title'), id),
          kind: t,
        };
      });
      setMsgs((m) => [...m, { role: 'assistant', text: `${str(r, 'reply', 'answer', 'message')}${str(r, 'disclaimer') ? `\n\n※ ${str(r, 'disclaimer')}` : ''}`, suggestions }]);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  if (err instanceof ApiError && err.kind === 'disabled')
    return (
      <EmptyState illo="calendar" title={L('AI 도우미는 곧 열려요', 'The assistant is coming soon')} action={<ButtonLink href="/stay" variant="primary">{L('숙소 직접 찾기', 'Search stays yourself')}</ButtonLink>}>
        {L('준비가 끝나면 알림으로 알려드릴게요. 그동안 숙소·가이드·투어를 직접 둘러보세요.', 'We’ll let you know when it’s ready. Meanwhile, browse stays, guides and tours.')}
      </EmptyState>
    );
  return (
    <div className="stack">
      <div className={`thread ${s.thread}`} aria-live="polite" aria-busy={busy || undefined}>
        {msgs.length === 0 && (
          <div className="center stack" style={{ margin: 'auto', maxWidth: 520 }}>
            <span className={s.icoTile} style={{ margin: '0 auto' }} aria-hidden="true">
              <Icon name="sparkle" size={22} />
            </span>
            <strong>{L('어떤 여행을 계획하고 계세요?', 'What trip are you planning?')}</strong>
            <p className="small muted" style={{ margin: 0 }}>{L('지역·기간·인원·예산을 알려주시면 실시간 숙소·가이드·투어를 찾아드려요.', 'Tell me where, when, who and your budget — I’ll find live stays, guides and tours.')}</p>
            <div className="chip-group" style={{ justifyContent: 'center' }}>
              {examples.map((e) => (
                <button key={e} type="button" className="chip" onClick={() => void send(e)} style={{ whiteSpace: 'normal', textAlign: 'left' }}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role === 'user' ? 'me' : ''}`}>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.text}</p>
            {m.suggestions && m.suggestions.length > 0 && (
              <div className={s.sugg}>
                {m.suggestions.slice(0, 6).map((sg) => (
                  <Link key={sg.href + sg.title} href={sg.href} className={s.suggCard}>
                    <Photo src={sg.img} alt="" sizes="160px" />
                    <span className={s.t}>
                      <strong>{sg.title}</strong>
                      <span>{[sg.meta, sg.price].filter(Boolean).join(' · ')}</span>
                      {sg.reason && <span>{sg.reason}</span>}
                    </span>
                    <Icon name="right" size={16} style={{ marginLeft: 'auto', flex: '0 0 auto', color: 'var(--text-muted)' }} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="bubble" role="status">
            <span className={s.typing} aria-label={L('답변을 준비하고 있어요', 'Thinking…')}>
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className={s.composer}
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <label className="sr-only" htmlFor="ask">
          {L('질문', 'Message')}
        </label>
        <input id="ask" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={L('예: 12월에 부산 바다 앞 숙소, 3인', 'e.g. A seaside stay in Busan in December for 3')} enterKeyHint="send" autoComplete="off" />
        <Button type="submit" variant="primary" icon="right" disabled={!text.trim()} loading={busy}>
          {L('보내기', 'Send')}
        </Button>
      </form>
      {msgs.length > 0 && (
        <div className="chip-group">
          {examples.slice(0, 2).map((e) => (
            <button key={e} type="button" className="chip" onClick={() => void send(e)} disabled={busy}>
              <Icon name="sparkle" size={14} /> {e}
            </button>
          ))}
        </div>
      )}
      <ErrorText error={err} />
    </div>
  );
}

/** AI travel assistant (AI-01). Advisory only: it never books or pays; suggestions link to real listings. */
export default function AssistantView() {
  const { L } = useI18n();
  const { ready, user } = useAuth();
  const examples = useExamples();
  return (
    <>
      <PageHeader title={L('AI 여행 도우미', 'AI travel assistant')} subtitle={L('일정·지역·예산을 알려주시면 JETPOOL 숙소·가이드·투어를 찾아드려요. 답변은 참고용이며, 예약과 결제는 직접 확인한 뒤에만 진행돼요.', 'Advisory only — bookings and payments always need your confirmation.')} actions={<ButtonLink href="/trip-planner" icon="calendar">{L('내 여행 플래너', 'My trip planner')}</ButtonLink>} />
      {ready && !user ? (
        <AuthTeaser
          title={L('로그인하고 AI에게 여행을 맡겨 보세요', 'Log in to plan with AI')}
          lead={L('대화 내용은 내 계정에만 저장되고, 추천 결과는 실시간 예약 가능 정보와 함께 보여드려요.', 'Conversations are saved to your account only, and suggestions use live availability.')}
          benefits={[
            { icon: 'search', title: L('실시간 검색', 'Live search'), body: L('지금 예약 가능한 숙소·가이드·투어만 골라요.', 'Only stays, guides and tours you can actually book.') },
            { icon: 'sparkle', title: L('추천 이유까지', 'Reasons included'), body: L('왜 이 숙소인지 근거를 함께 알려드려요.', 'Every suggestion explains why it fits.') },
            { icon: 'shield', title: L('예약은 내가 결정', 'You decide'), body: L('AI는 예약·결제를 하지 않아요. 확인 후 직접 진행해요.', 'The AI never books or pays — you confirm everything.') },
          ]}
          preview={
            <>
              <div className="bubble me" style={{ maxWidth: '90%', alignSelf: 'flex-end', justifySelf: 'end' }}>
                <p style={{ margin: 0 }}>{examples[0]}</p>
              </div>
              <div className="bubble" style={{ maxWidth: '92%' }}>
                <p className="small" style={{ margin: 0 }}>{L('제주 2명 조건으로 7곳을 찾았어요. 협재 해변 5분 거리 돌집이 가장 잘 맞아요.', 'I found 7 places in Jeju for two. A stone house five minutes from Hyeopjae beach fits best.')}</p>
                <div className={s.sugg}>
                  <span className={s.suggCard}>
                    <Photo src="/art/postcards/jeju.svg" alt="" sizes="160px" />
                    <span className={s.t}>
                      <strong>{L('한림 돌담 독채', 'Hallim stone house')}</strong>
                      <span>{L('숙소 · 제주 · ₩190,000 / 박', 'Stay · Jeju · ₩190,000 / night')}</span>
                    </span>
                  </span>
                </div>
              </div>
            </>
          }
        />
      ) : (
        <RequireAuth>
          <Chat />
        </RequireAuth>
      )}
    </>
  );
}
