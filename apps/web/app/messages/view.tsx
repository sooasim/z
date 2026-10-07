'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { newIdempotencyKey, post } from '@/lib/api';
import { items, str, num, f } from '@/lib/shape';
import { subscribeRealtime } from '@/lib/realtime';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Avatar, DateText, ErrorText, PageHeader } from '@/components/ui';

const CONTEXT_LABEL: Record<string, [string, string]> = {
  RESERVATION: ['숙소 예약', 'Stay'],
  EXCHANGE: ['홈 맞교환', 'Exchange'],
  GUIDE_REQUEST: ['가이드 요청', 'Guide request'],
  GUIDE_BOOKING: ['가이드 예약', 'Guide booking'],
  ORDER: ['여행 주문', 'Order'],
  SUPPORT: ['고객센터', 'Support'],
  INQUIRY: ['숙소 문의', 'Inquiry'],
};

function Thread({ cid, onActivity, names }: { cid: string; onActivity: () => void; names: Record<string, string> }) {
  const { L } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/conversations/${cid}/messages`, { auth: true, query: { limit: 50 } });
  const [extra, setExtra] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const reload = st.reload;

  useEffect(() => setExtra([]), [cid]);
  useEffect(() => {
    post(`/v1/conversations/${cid}/read`, {}).catch(() => {});
  }, [cid, st.data]);
  useEffect(() => {
    return subscribeRealtime((e) => {
      const m = e.json?.message ?? e.json?.payload ?? e.json;
      const c = str(m, 'conversationId') || str(e.json, 'conversationId');
      if (c === cid) {
        if (str(m, 'id') && str(m, 'body', 'text')) setExtra((x) => (x.some((y) => str(y, 'id') === str(m, 'id')) ? x : [...x, m]));
        else reload();
      } else if (c) onActivity();
    });
  }, [cid, reload, onActivity]);

  const base = items(st.data);
  // API may return newest-first; display oldest-first.
  const sorted = [...base].sort((a, b) => str(a, 'createdAt').localeCompare(str(b, 'createdAt')));
  const all = [...sorted, ...extra.filter((m) => !sorted.some((s) => str(s, 'id') === str(m, 'id')))];
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [all.length]);

  return (
    <section className="stack" aria-label={L('대화', 'Conversation')}>
      <StateView state={st}>
        {() => (
          <div className="thread" role="log" aria-live="polite">
            {all.length === 0 && <p className="muted center">{L('첫 메시지를 보내보세요.', 'Say hello.')}</p>}
            {all.map((m: any) => {
              const mine = str(m, 'senderId', 'authorId', 'sender.id') === user?.id;
              const system = str(m, 'kind', 'type').toUpperCase() === 'SYSTEM';
              return (
                <div key={str(m, 'id')} className={`bubble ${mine ? 'me' : ''}`} style={system ? { alignSelf: 'center', background: 'var(--c-surface-2)', color: 'var(--c-muted)' } : undefined}>
                  {!mine && !system && <div className="small" style={{ fontWeight: 700 }}>{names[str(m, 'senderId')] || str(m, 'senderName', 'sender.displayName')}</div>}
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{f(m, 'redacted') ? <em className="muted">{L('삭제·가려진 메시지', 'Message removed')}</em> : str(m, 'body', 'text', 'content')}</p>
                  <div className="row between small" style={{ opacity: 0.8 }}>
                    <DateText value={str(m, 'createdAt')} time />
                    {!mine && !system && (
                      <button
                        className="btn ghost sm"
                        style={{ minHeight: 24, padding: '0 4px', color: 'inherit' }}
                        onClick={async () => {
                          const reason = window.prompt(L('신고 사유를 입력하세요', 'Why are you reporting this message?'));
                          if (!reason) return;
                          try {
                            await post(`/v1/messages/${str(m, 'id')}/report`, { reason });
                            window.alert(L('신고가 접수되었습니다.', 'Report submitted.'));
                          } catch (x) {
                            setErr(x);
                          }
                        }}
                      >
                        {L('신고', 'Report')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </StateView>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setSending(true);
          setErr(null);
          const clientId = newIdempotencyKey();
          try {
            const r = await post(`/v1/conversations/${cid}/messages`, { body: text.trim(), clientMessageId: clientId }, { idempotencyKey: clientId });
            const m = f(r, 'item') ?? r;
            setExtra((x) => [...x, { ...m, senderId: str(m, 'senderId') || user?.id, body: str(m, 'body') || text.trim(), createdAt: str(m, 'createdAt') || new Date().toISOString(), id: str(m, 'id') || clientId }]);
            setText('');
          } catch (x) {
            setErr(x);
          } finally {
            setSending(false);
          }
        }}
      >
        <label htmlFor="msg" className="sr-only">{L('메시지', 'Message')}</label>
        <textarea id="msg" rows={2} style={{ flex: 1, minHeight: 48 }} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder={L('메시지 입력… (연락처·외부 결제 유도는 제한됩니다)', 'Message… (sharing contact/off-platform payment is restricted)')} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }} />
        <button className="btn primary" disabled={sending}>{L('보내기', 'Send')}</button>
      </form>
      <ErrorText error={err} />
    </section>
  );
}

export default function MessagesView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const cid = sp.get('c') ?? '';
  const { user } = useAuth();
  const list = useApi<any>('/v1/conversations', { auth: true });
  const reloadList = list.reload;
  const convs = items(list.data);
  const others = (c: any) => (Array.isArray(c?.members) ? c.members.filter((m: any) => str(m, 'userId') !== user?.id) : []);
  const titleOf = (c: any) => others(c).map((m: any) => str(m, 'displayName')).filter(Boolean).join(', ');
  const current = convs.find((c: any) => str(c, 'id') === cid);
  const names: Record<string, string> = Object.fromEntries((Array.isArray(current?.members) ? current.members : []).map((m: any) => [str(m, 'userId'), str(m, 'displayName')]));
  useEffect(() => {
    if (!cid) return subscribeRealtime(() => reloadList());
  }, [cid, reloadList]);
  return (
    <RequireAuth>
      <PageHeader title={L('메시지', 'Messages')} />
      <div className="chat">
        <nav aria-label={L('대화 목록', 'Conversations')} className={cid ? 'hide-mobile' : ''}>
          <StateView state={list} isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="messages" title={L('대화가 없습니다.', 'No conversations.')}><p className="muted small">{L('예약·맞교환·가이드 요청을 하면 대화방이 생겨요.', 'Conversations open with bookings and requests.')}</p></EmptyState>}>
            {(d) => (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack">
                {items(d).map((c: any) => {
                  const id = str(c, 'id');
                  const unread = num(c, 'unreadCount', 'unread') ?? 0;
                  const ctx = CONTEXT_LABEL[str(c, 'contextType').toUpperCase()];
                  return (
                    <li key={id}>
                      <Link className="conv" href={`/messages?c=${id}`} aria-current={id === cid ? 'true' : undefined}>
                        <Avatar name={titleOf(c) || str(c, 'contextType') || '?'} size={44} />
                        <div className="grow">
                          <div className="row between nowrap" style={{ gap: 8 }}>
                            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titleOf(c) || (ctx ? ctx[lang === 'ko' ? 0 : 1] : L('대화', 'Chat'))}</strong>
                            {unread > 0 && <span className="badge accent" aria-label={`${unread} ${L('읽지 않음', 'unread')}`}>{unread}</span>}
                          </div>
                          {ctx && <span className="badge" style={{ marginTop: 2 }}>{ctx[lang === 'ko' ? 0 : 1]}</span>}
                          <div className="small muted" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: 2 }}>{str(c, 'lastMessage.body', 'lastMessageText', 'preview')}</div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </StateView>
        </nav>
        <div>
          {cid ? (
            <>
              <button className="btn sm ghost" onClick={() => router.push('/messages')}>← {L('목록', 'All')}</button>
              <Thread cid={cid} onActivity={reloadList} names={names} />
            </>
          ) : (
            <div className="state">{L('대화를 선택하세요.', 'Select a conversation.')}</div>
          )}
        </div>
      </div>
    </RequireAuth>
  );
}

