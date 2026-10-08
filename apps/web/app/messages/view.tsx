'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { newIdempotencyKey, post } from '@/lib/api';
import { items, str, num, f } from '@/lib/shape';
import { subscribeRealtime } from '@/lib/realtime';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Avatar, Button, ButtonLink, ErrorText, Icon, PageHeader, useConfirm, useMediaQuery } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { styles as s } from '@/components/traveler/ui';
import { useContextSummary } from '@/components/traveler/hooks';
import { clockTime, daySeparator, relTime, subjectLabel } from '@/components/traveler/labels';

const CONTEXT_TONE: Record<string, string> = { EXCHANGE: 'exchange', INQUIRY: 'info', SUPPORT: 'warn' };

function ContextBadge({ type }: { type: string }) {
  const { lang } = useI18n();
  const t = type.toUpperCase();
  if (!t) return null;
  return <span className={`badge ${CONTEXT_TONE[t] ?? ''}`}>{subjectLabel(t, lang)}</span>;
}

function ConvRow({ c, active, me }: { c: any; active: boolean; me?: string }) {
  const { L, lang } = useI18n();
  const id = str(c, 'id');
  const others = (Array.isArray(c?.members) ? c.members : []).filter((m: any) => str(m, 'userId') !== me);
  const name = others.map((m: any) => str(m, 'displayName')).filter(Boolean).join(', ') || subjectLabel(str(c, 'contextType'), lang);
  const ctx = useContextSummary(str(c, 'contextType'), str(c, 'contextId'), L);
  const unread = num(c, 'unreadCount', 'unread') ?? 0;
  const last = str(c, 'lastMessage.body', 'lastMessageText', 'preview');
  const when = str(c, 'lastMessageAt', 'lastMessage.createdAt') || str(c, 'createdAt');
  return (
    <li>
      <Link className="conv" href={`/messages?c=${id}`} aria-current={active ? 'true' : undefined}>
        <Avatar name={name} size={44} decorative />
        <div className="grow">
          <div className="row between nowrap" style={{ gap: 8 }}>
            <strong className={s.convTitle}>{name}</strong>
            <span className="xs muted" style={{ whiteSpace: 'nowrap' }}>{relTime(when, lang)}</span>
          </div>
          <div className={s.convMeta}>
            <ContextBadge type={str(c, 'contextType')} />
            {ctx?.title && <span className={s.convTitle}>{ctx.title}</span>}
          </div>
          <div className="row between nowrap" style={{ gap: 8, marginTop: 2 }}>
            <span className="small muted" style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontWeight: unread ? 700 : undefined, color: unread ? 'var(--text)' : undefined }}>
              {last || L('아직 메시지가 없어요', 'No messages yet')}
            </span>
            {unread > 0 && (
              <span className="badge accent" style={{ flex: '0 0 auto' }}>
                {unread}
                <span className="sr-only">{L('개 읽지 않음', ' unread')}</span>
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

function ThreadHeader({ conv, me }: { conv: any; me?: string }) {
  const { L, lang } = useI18n();
  const router = useRouter();
  const others = (Array.isArray(conv?.members) ? conv.members : []).filter((m: any) => str(m, 'userId') !== me);
  const name = others.map((m: any) => str(m, 'displayName')).filter(Boolean).join(', ') || subjectLabel(str(conv, 'contextType'), lang);
  const role = str(others[0], 'role');
  const ctx = useContextSummary(str(conv, 'contextType'), str(conv, 'contextId'), L);
  return (
    <div className={s.threadHead}>
      <span className={s.backMobile}>
        <Button variant="ghost" size="sm" icon="left" label={L('대화 목록', 'All conversations')} onClick={() => router.push('/messages')} />
      </span>
      <Avatar name={name} size={40} decorative />
      <div className="grow">
        <strong>{name}</strong>
        <div className={s.ctx}>
          {[role && ({ HOST: L('호스트', 'Host'), GUEST: L('게스트', 'Guest'), GUIDE: L('가이드', 'Guide'), TRAVELER: L('여행자', 'Traveler'), SUPPLIER: L('공급사', 'Supplier') } as Record<string, string>)[role.toUpperCase()], subjectLabel(str(conv, 'contextType'), lang), ctx?.title].filter(Boolean).join(' · ')}
        </div>
      </div>
      {ctx?.href && (
        <ButtonLink size="sm" href={ctx.href} iconRight="right">
          {ctx.linkLabel}
        </ButtonLink>
      )}
    </div>
  );
}

function Thread({ cid, onActivity, names, conv }: { cid: string; onActivity: () => void; names: Record<string, string>; conv: any }) {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const st = useApi<any>(`/v1/conversations/${cid}/messages`, { auth: true, query: { limit: 50 } });
  const [extra, setExtra] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const reload = st.reload;

  useEffect(() => setExtra([]), [cid]);
  useEffect(() => {
    post(`/v1/conversations/${cid}/read`, {}).then(onActivity).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // API returns newest-first; display oldest-first.
  const sorted = [...base].sort((a, b) => str(a, 'createdAt').localeCompare(str(b, 'createdAt')));
  const all = [...sorted, ...extra.filter((m) => !sorted.some((x) => str(x, 'id') === str(m, 'id')))];
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [all.length]);

  const report = async (m: any) => {
    const r = await confirm({
      title: L('메시지 신고', 'Report message'),
      icon: 'flag',
      tone: 'danger',
      body: L('신고 내용은 운영팀만 확인하며, 상대방에게 알리지 않아요. 긴급한 안전 문제라면 112/119에 먼저 연락하세요.', 'Only our trust & safety team sees reports; the other person is not notified. In an emergency call local services first.'),
      requireReason: L('신고 사유', 'Reason'),
      reasonMinLength: 3,
      reasonPlaceholder: L('예: 외부 결제 유도, 연락처 요구, 불쾌한 표현', 'e.g. off-platform payment, asking for contacts, abuse'),
      confirmLabel: L('신고하기', 'Report'),
      run: (reason) => post(`/v1/messages/${str(m, 'id')}/report`, { reason }),
    });
    if (r.ok) toast.show(L('신고가 접수되었어요. 확인 후 조치할게요.', 'Report received. We’ll review it.'));
  };

  return (
    <section className={`stack ${s.threadWrap}`} aria-label={L('대화', 'Conversation')}>
      {dialog}
      <ThreadHeader conv={conv} me={user?.id} />
      <StateView state={st}>
        {() => {
          let lastDay = '';
          return (
          <div className="thread" role="log" aria-live="polite" aria-label={L('메시지 내역', 'Messages')}>
            {all.length === 0 && <p className="muted center small" style={{ margin: 'auto' }}>{L('첫 메시지를 보내 인사해 보세요.', 'Say hello to get started.')}</p>}
            {all.map((m: any) => {
              const mine = str(m, 'senderId', 'authorId', 'sender.id') === user?.id;
              const system = ['SYSTEM', 'EVENT'].includes(str(m, 'kind', 'type').toUpperCase());
              const at = str(m, 'createdAt');
              const dayKey = at.slice(0, 10) ? new Date(at).toDateString() : '';
              const sep = dayKey && dayKey !== lastDay ? daySeparator(at, lang) : '';
              lastDay = dayKey || lastDay;
              return (
                <Fragment key={str(m, 'id')}>
                  {sep && (
                    <div className={s.daySep} role="separator" aria-label={sep}>
                      {sep}
                    </div>
                  )}
                  {system ? (
                    <div className={s.systemBubble}>{str(m, 'body', 'text')}</div>
                  ) : (
                    <div className={`bubble ${mine ? 'me' : ''}`}>
                      {!mine && <div className="xs" style={{ fontWeight: 700 }}>{names[str(m, 'senderId')] || str(m, 'senderName', 'sender.displayName')}</div>}
                      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{f(m, 'redacted') ? <em className="muted">{L('가려진 메시지예요', 'Message hidden')}</em> : str(m, 'body', 'text', 'content')}</p>
                      <div className={s.bubbleMeta}>
                        <time dateTime={at}>{clockTime(at, lang)}</time>
                        {!mine && (
                          <button type="button" className="btn ghost sm" style={{ minHeight: 24, padding: '0 6px', color: 'inherit', fontSize: 'var(--fs-2xs)' }} onClick={() => report(m)}>
                            {L('신고', 'Report')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
            <div ref={endRef} />
          </div>
          );
        }}
      </StateView>
      <form
        className={s.composer}
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
            onActivity();
          } catch (x) {
            setErr(x);
          } finally {
            setSending(false);
          }
        }}
      >
        <label htmlFor="msg" className="sr-only">
          {L('메시지', 'Message')}
        </label>
        <textarea
          id="msg"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          aria-describedby="msg-hint"
          placeholder={L('메시지를 입력하세요', 'Write a message')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }
          }}
        />
        <Button type="submit" variant="primary" icon="right" loading={sending} disabled={!text.trim()}>
          {L('보내기', 'Send')}
        </Button>
      </form>
      <p id="msg-hint" className="xs muted" style={{ margin: 0 }}>
        {L('안전한 거래를 위해 연락처 공유와 외부 결제 유도는 제한돼요. Enter로 보내고 Shift+Enter로 줄을 바꿔요.', 'For your safety, sharing contacts and off-platform payments are restricted. Enter sends, Shift+Enter adds a line.')}
      </p>
      <ErrorText error={err} />
    </section>
  );
}

export default function MessagesView() {
  const { L } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const cid = sp.get('c') ?? '';
  const { user } = useAuth();
  const desktop = useMediaQuery('(min-width: 900px)');
  const list = useApi<any>('/v1/conversations', { auth: true, query: { limit: 100 } });
  const reloadList = list.reload;
  const convs = items(list.data).sort((a: any, b: any) => (str(b, 'lastMessageAt') || str(b, 'createdAt')).localeCompare(str(a, 'lastMessageAt') || str(a, 'createdAt')));
  const current = convs.find((c: any) => str(c, 'id') === cid) ?? (cid ? { id: cid } : null);
  const names: Record<string, string> = Object.fromEntries((Array.isArray(current?.members) ? current.members : []).map((m: any) => [str(m, 'userId'), str(m, 'displayName')]));
  // Desktop: open the most recent conversation instead of an empty pane.
  useEffect(() => {
    if (desktop && !cid && convs.length) router.replace(`/messages?c=${str(convs[0], 'id')}`, { scroll: false });
  }, [desktop, cid, convs.length, router]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cid) return subscribeRealtime(() => reloadList());
  }, [cid, reloadList]);
  const hasList = items(list.data).length > 0;
  return (
    <RequireAuth>
      <div className={cid ? 'hide-mobile' : ''}>
        <PageHeader title={L('메시지', 'Messages')} />
      </div>
      {cid && !desktop && <h1 className="sr-only">{L('메시지', 'Messages')}</h1>}
      <div className="chat">
        <nav aria-label={L('대화 목록', 'Conversations')} className={cid ? 'hide-mobile' : ''} style={{ minWidth: 0 }}>
          <StateView
            state={list}
            isEmpty={(d) => items(d).length === 0}
            empty={
              <EmptyState illo="messages" title={L('아직 대화가 없어요', 'No conversations yet')} action={<ButtonLink variant="primary" href="/stay">{L('숙소 둘러보기', 'Browse stays')}</ButtonLink>}>
                {L('숙소에 문의하거나 예약·맞교환·가이드 요청을 하면 대화방이 생겨요.', 'Conversations open when you ask a host or make a booking or request.')}
              </EmptyState>
            }
          >
            {() => (
              <ul className={s.convList}>
                {convs.map((c: any) => (
                  <ConvRow key={str(c, 'id')} c={c} active={str(c, 'id') === cid} me={user?.id} />
                ))}
              </ul>
            )}
          </StateView>
        </nav>
        <div style={{ minWidth: 0 }}>
          {cid ? (
            <Thread cid={cid} onActivity={reloadList} names={names} conv={current} />
          ) : hasList ? (
            <div className="state hide-mobile">
              <Icon name="chat" size={28} style={{ margin: '0 auto 8px', color: 'var(--text-muted)' }} />
              <p className="muted" style={{ margin: 0 }}>{L('왼쪽에서 대화를 선택하세요.', 'Pick a conversation on the left.')}</p>
            </div>
          ) : null}
        </div>
      </div>
    </RequireAuth>
  );
}
