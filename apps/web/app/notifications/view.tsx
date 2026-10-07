'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { subscribeRealtime } from '@/lib/realtime';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { DateText, PageHeader } from '@/components/ui';

export default function NotificationsView() {
  const { L } = useI18n();
  const st = useApi<any>('/v1/notifications', { auth: true });
  const { reload } = st;
  useEffect(() => subscribeRealtime((e) => { if (e.event.startsWith('notification')) reload(); }), [reload]);
  return (
    <RequireAuth>
      <PageHeader
        title={L('알림', 'Notifications')}
        actions={
          <>
            <button className="btn sm" onClick={async () => { try { await post('/v1/notifications/read-all', {}); } catch { /* optional endpoint */ } reload(); }}>{L('모두 읽음', 'Mark all read')}</button>
            <Link className="btn sm" href="/account/notifications">{L('설정', 'Settings')}</Link>
          </>
        }
      />
      <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="messages" title={L('새 알림이 없습니다.', 'No notifications.')} />}>
        {(d) => (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {items(d).map((n: any) => {
              const unread = !str(n, 'readAt');
              const href = str(n, 'link', 'url', 'deepLink', 'data.url');
              return (
                <li key={str(n, 'id')} className="card flat row between" style={{ background: unread ? 'var(--c-primary-soft)' : undefined }}>
                  <div>
                    {unread && <span className="unread-dot" aria-label={L('읽지 않음', 'Unread')} />} <strong>{str(n, 'title', 'subject', 'template')}</strong>
                    <p style={{ margin: 0 }}>{str(n, 'body', 'message')}</p>
                    <span className="small muted"><DateText value={str(n, 'createdAt')} time /></span>
                  </div>
                  <div className="row">
                    {href && href.startsWith('/') && <Link className="btn sm" href={href}>{L('보기', 'Open')}</Link>}
                    {unread && <button className="btn sm" onClick={async () => { try { await post(`/v1/notifications/${str(n, 'id')}/read`, {}); reload(); } catch { /* ignore */ } }}>{L('읽음', 'Read')}</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </StateView>
    </RequireAuth>
  );
}
