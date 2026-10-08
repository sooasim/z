'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, num, str } from '@/lib/shape';
import { subscribeRealtime } from '@/lib/realtime';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Button, ButtonLink, Icon, PageHeader, type IconName } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { styles as s } from '@/components/traveler/ui';
import { dayBucket, notificationHref, notificationText, relTime } from '@/components/traveler/labels';

function iconFor(key: string): IconName {
  const k = key.toLowerCase();
  if (k.startsWith('reservation')) return 'home';
  if (k.startsWith('payment') || k.startsWith('refund')) return 'card';
  if (k.startsWith('guide')) return 'compass';
  if (k.startsWith('message')) return 'chat';
  if (k.startsWith('order')) return 'ticket';
  if (k.startsWith('review')) return 'star';
  if (k.startsWith('exchange')) return 'swap';
  if (k.startsWith('security') || k.startsWith('auth') || k.startsWith('mfa')) return 'shield';
  return 'bell';
}

export default function NotificationsView() {
  const { L, lang } = useI18n();
  const toast = useToast();
  const st = useApi<any>('/v1/notifications', { auth: true, query: { limit: 100 } });
  const { reload } = st;
  const [readLocal, setReadLocal] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeRealtime((e) => { if (e.event.startsWith('notification')) reload(); }), [reload]);
  const list = items(st.data);
  const isUnread = (n: any) => !str(n, 'readAt') && !readLocal.has(str(n, 'id'));
  const unread = st.data ? (num(st.data, 'unreadCount') ?? list.filter((n) => !str(n, 'readAt')).length) - list.filter((n) => !str(n, 'readAt') && readLocal.has(str(n, 'id'))).length : 0;
  const markRead = (id: string) => {
    setReadLocal((x) => new Set(x).add(id));
    post(`/v1/notifications/${id}/read`, {}).catch(() => {});
  };
  const groups: Array<[string, any[]]> = [
    [L('오늘', 'Today'), list.filter((n) => dayBucket(str(n, 'createdAt')) === 'today')],
    [L('이번 주', 'This week'), list.filter((n) => dayBucket(str(n, 'createdAt')) === 'week')],
    [L('이전', 'Earlier'), list.filter((n) => dayBucket(str(n, 'createdAt')) === 'older')],
  ];
  return (
    <RequireAuth>
      <PageHeader
        title={L('알림', 'Notifications')}
        subtitle={unread > 0 ? L(`읽지 않은 알림 ${unread}개`, `${unread} unread`) : L('모든 알림을 확인했어요.', 'You’re all caught up.')}
        actions={
          <>
            <Button
              size="sm"
              icon="check"
              disabled={unread <= 0 || busy}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await post('/v1/notifications/read-all', {});
                  setReadLocal(new Set(list.map((n) => str(n, 'id'))));
                  toast.show(L('모든 알림을 읽음으로 표시했어요', 'All marked as read'), { ms: 2200 });
                } catch {
                  toast.show(L('처리하지 못했어요. 다시 시도해 주세요.', 'Something went wrong. Try again.'), { tone: 'error' });
                } finally {
                  setBusy(false);
                  reload();
                }
              }}
            >
              {L('모두 읽음', 'Mark all read')}
            </Button>
            <ButtonLink size="sm" icon="settings" href="/account/notifications">
              {L('알림 설정', 'Settings')}
            </ButtonLink>
          </>
        }
      />
      <StateView
        state={st}
        isEmpty={(d) => items(d).length === 0}
        empty={
          <EmptyState illo="generic" title={L('새 알림이 없어요', 'No notifications yet')} action={<ButtonLink variant="primary" href="/trips">{L('내 여행 보기', 'View my trips')}</ButtonLink>}>
            {L('예약 확정, 결제, 메시지, 가이드 제안 소식을 여기서 알려드려요.', 'Booking, payment, message and guide updates will show up here.')}
          </EmptyState>
        }
      >
        {() => (
          <div className="stack-lg">
            {groups.map(([label, arr]) =>
              arr.length ? (
                <section key={label} aria-label={label}>
                  <h2 className="small muted" style={{ margin: '0 0 8px', fontSize: 'var(--fs-sm)', fontWeight: 700 }}>
                    {label}
                  </h2>
                  <ul className={s.notifList}>
                    {arr.map((n: any) => {
                      const id = str(n, 'id');
                      const un = isUnread(n);
                      const href = notificationHref(n);
                      const { title, body } = notificationText(n, lang);
                      const at = str(n, 'createdAt');
                      return (
                        <li key={id} className={`${s.notif} ${un ? s.unread : ''}`}>
                          <span className={s.notifIco} aria-hidden="true">
                            <Icon name={iconFor(str(n, 'templateKey', 'template'))} size={20} />
                          </span>
                          <div style={{ minWidth: 0 }}>
                            {href ? (
                              <Link href={href} className={s.notifLink} onClick={() => un && markRead(id)}>
                                <strong>{title}</strong>
                              </Link>
                            ) : (
                              <strong>{title}</strong>
                            )}
                            {body && <p>{body}</p>}
                            <time dateTime={at} title={new Date(at).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US')}>
                              {relTime(at, lang)}
                            </time>
                          </div>
                          <div className={s.notifSide}>
                            {un && (
                              <>
                                <span className="unread-dot" aria-hidden="true" />
                                <span className="sr-only">{L('읽지 않음', 'Unread')}</span>
                              </>
                            )}
                            {un && !href && (
                              <Button size="sm" variant="ghost" onClick={() => markRead(id)}>
                                {L('읽음', 'Mark read')}
                              </Button>
                            )}
                            {href && <Icon name="right" size={18} style={{ color: 'var(--text-subtle)' }} />}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null,
            )}
          </div>
        )}
      </StateView>
    </RequireAuth>
  );
}
