'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { items, str, f, item } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, Button, ErrorText, Icon, PageHeader, type IconName } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { Switch } from '@/components/traveler/ui';
import { channelLabel } from '@/components/traveler/labels';
import { pickText } from '@/lib/phrases';

const CATEGORIES: Array<{ key: string; icon: IconName; ko: string; en: string; dko: string; den: string; locked?: boolean }> = [
  { key: 'TRANSACTIONAL', icon: 'bag', ko: '예약·결제·메시지', en: 'Bookings, payments & messages', dko: '예약 확정, 결제 영수증, 새 메시지처럼 여행에 꼭 필요한 알림이에요.', den: 'Booking confirmations, receipts and new messages.' },
  { key: 'SECURITY', icon: 'shield', ko: '보안', en: 'Security', dko: '새 기기 로그인, 비밀번호 변경 등은 계정 보호를 위해 끌 수 없어요.', den: 'New sign-ins and password changes can’t be turned off.', locked: true },
  { key: 'SYSTEM', icon: 'info', ko: '서비스 공지', en: 'Service notices', dko: '약관 변경, 점검 안내 등 서비스 운영 소식이에요.', den: 'Terms updates and maintenance notices.' },
  { key: 'MARKETING', icon: 'sparkle', ko: '혜택·마케팅', en: 'Offers & marketing', dko: '할인·이벤트 소식이에요. 마케팅 수신 동의가 필요해요.', den: 'Deals and events. Requires marketing consent.' },
];
const CHANNELS: Array<{ key: string; icon: IconName }> = [
  { key: 'IN_APP', icon: 'bell' },
  { key: 'EMAIL', icon: 'mail' },
  { key: 'SMS', icon: 'phone' },
  { key: 'PUSH', icon: 'chat' },
  { key: 'KAKAO_ALIMTALK', icon: 'chat' },
];

type State = Record<string, { enabled: boolean; mandatory: boolean }>;

function Form({ rows, onSaved }: { rows: any[]; onSaved: () => void }) {
  const { L, lang } = useI18n();
  const toast = useToast();
  const init = (): State => {
    const s: State = {};
    for (const c of CATEGORIES)
      for (const ch of CHANNELS) {
        const r = rows.find((x: any) => str(x, 'category', 'topic').toUpperCase() === c.key && str(x, 'channel').toUpperCase() === ch.key);
        const mandatory = f(r, 'mandatory') === true;
        s[`${c.key}:${ch.key}`] = { enabled: mandatory || (r ? f(r, 'enabled', 'optIn') !== false : c.key !== 'MARKETING'), mandatory: mandatory || !!c.locked };
      }
    return s;
  };
  const [state, setState] = useState<State>(init);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!dirty) setState(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  return (
    <form
      className="stack-lg"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const preferences = Object.entries(state)
            .filter(([, v]) => !v.mandatory)
            .map(([k, v]) => {
              const [category, channel] = k.split(':');
              return { category, channel, enabled: v.enabled };
            });
          await api('/v1/notification-preferences', { method: 'PATCH', body: { preferences } });
          setDirty(false);
          toast.show(L('알림 설정을 저장했어요', 'Notification settings saved'));
          onSaved();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      {CATEGORIES.map((c) => (
        <fieldset key={c.key} className="card stack" style={{ margin: 0 }}>
          <legend className="sr-only">{pickText(c, lang)}</legend>
          <div className="row nowrap" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--brand-soft)', color: 'var(--brand)', flex: '0 0 auto' }} aria-hidden="true">
              <Icon name={c.icon} size={20} />
            </span>
            <div className="grow">
              <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{pickText(c, lang)}</h2>
              <p className="small muted" style={{ margin: '2px 0 0' }} id={`desc-${c.key}`}>
                {lang === 'ko' ? c.dko : c.den}
              </p>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 0, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', columnGap: 24 }}>
            {CHANNELS.map((ch) => {
              const k = `${c.key}:${ch.key}`;
              const v = state[k];
              return (
                <li key={ch.key} className="row between nowrap" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', gap: 12 }}>
                  <span className="row nowrap" style={{ gap: 8 }}>
                    <Icon name={ch.icon} size={18} style={{ color: 'var(--text-muted)' }} />
                    <span className="small" style={{ fontWeight: 600 }}>{channelLabel(ch.key, lang)}</span>
                    {v.mandatory && <span className="xs muted">{L('필수', 'Required')}</span>}
                  </span>
                  <Switch
                    checked={v.enabled}
                    disabled={v.mandatory}
                    label={`${pickText(c, lang)} · ${channelLabel(ch.key, lang)}`}
                    describedBy={`desc-${c.key}`}
                    onChange={(on) => {
                      setDirty(true);
                      setState((s) => ({ ...s, [k]: { ...s[k], enabled: on } }));
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
          {L('변경사항 저장', 'Save changes')}
        </Button>
        {!dirty && <span className="xs muted">{L('변경한 내용이 없어요', 'No unsaved changes')}</span>}
      </div>
      <ErrorText error={err} />
    </form>
  );
}

export default function NotificationPrefsView() {
  const { L } = useI18n();
  const st = useApi<any>('/v1/notification-preferences', { auth: true });
  return (
    <RequireAuth>
      <PageHeader title={L('알림 설정', 'Notification settings')} subtitle={L('어떤 소식을 어디로 받을지 고르세요. 보안·법정 고지 알림은 끌 수 없어요.', 'Choose what to hear about and where. Security and legal notices are always on.')} />
      <StateView state={st}>
        {(d) => {
          const rows = items(d).length ? items(d) : (f<any[]>(item(d), 'preferences') ?? []);
          return (
            <>
              <Form rows={rows} onSaved={st.reload} />
              <div style={{ marginTop: 16 }}>
                <Alert tone="info">{L('카카오 알림톡과 문자는 휴대폰 번호가 등록되어 있어야 받을 수 있어요. 프로필에서 번호를 추가하세요.', 'KakaoTalk and SMS need a phone number on your profile.')}</Alert>
              </div>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
