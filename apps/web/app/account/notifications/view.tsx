'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { items, str, f, item } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { ErrorText, PageHeader } from '@/components/ui';

const CATEGORIES = [
  { key: 'TRANSACTIONAL', ko: '예약·결제·메시지', en: 'Bookings, payments & messages' },
  { key: 'SECURITY', ko: '보안 (끌 수 없음)', en: 'Security (always on)', locked: true },
  { key: 'SYSTEM', ko: '서비스 공지', en: 'Service notices' },
  { key: 'MARKETING', ko: '혜택·마케팅 (동의 필요)', en: 'Promotions (consent required)' },
];
const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'KAKAO_ALIMTALK'];

export default function NotificationPrefsView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/notification-preferences', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  return (
    <RequireAuth>
      <PageHeader title={L('알림 설정', 'Notification settings')} subtitle={L('보안·법정 고지 알림은 끌 수 없습니다.', 'Security and legal notices cannot be disabled.')} />
      <StateView state={st}>
        {(d) => {
          const rows = items(d).length ? items(d) : (f<any[]>(item(d), 'preferences') ?? []);
          const isOn = (cat: string, ch: string) => {
            const r = rows.find((x: any) => str(x, 'category', 'topic').toUpperCase() === cat && str(x, 'channel').toUpperCase() === ch);
            return r ? f(r, 'enabled', 'optIn') !== false : cat !== 'MARKETING';
          };
          return (
            <form
              className="card stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const preferences = CATEGORIES.filter((c) => !(c as any).locked).flatMap((c) => CHANNELS.map((ch) => ({ category: c.key, channel: ch, enabled: fd.get(`${c.key}:${ch}`) === 'on' })));
                setErr(null);
                setSaved(false);
                try {
                  await api('/v1/notification-preferences', { method: 'PATCH', body: { preferences } });
                  setSaved(true);
                } catch (x) {
                  setErr(x);
                }
              }}
            >
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{L('분류', 'Category')}</th>
                      {CHANNELS.map((c) => (
                        <th key={c} scope="col">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {CATEGORIES.map((c) => (
                      <tr key={c.key}>
                        <th scope="row">{c[lang]}</th>
                        {CHANNELS.map((ch) => (
                          <td key={ch}>
                            <input type="checkbox" name={`${c.key}:${ch}`} defaultChecked={(c as any).locked || isOn(c.key, ch)} disabled={(c as any).locked} aria-label={`${c[lang]} ${ch}`} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row">
                <button className="btn primary">{L('저장', 'Save')}</button>
                {saved && <span className="badge ok">✓ {L('저장됨', 'Saved')}</span>}
              </div>
              <ErrorText error={err} />
            </form>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
