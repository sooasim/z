'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { arr, item, str } from '@/lib/shape';
import { Alert, ErrorText, Section, DateRangeField, Qty, Icon } from '@/components/ui';

const FALLBACK = {
  ko: {
    title: '전세기 공유 JETPOOL',
    lead: '같은 곳으로 떠나고 싶은 사람들이 모이면, 노선이 열립니다. WONT Travel Club에서 시작된 전세기 공유 여행을 JETPOOL에서 이어갑니다.',
    points: ['수요가 모이면 항공사·여행사와 전세기 운항을 협의합니다.', '확정 전까지는 비용이 발생하지 않는 사전 수요 조사입니다.', '항공권 판매·발권은 등록된 여행사가 진행합니다.'],
  },
  en: {
    title: 'Charter sharing JETPOOL',
    lead: 'When enough people want to go to the same place, a route opens. The charter sharing trips that began at WONT Travel Club continue on JETPOOL.',
    points: ['When demand gathers we negotiate charter operations with airlines and agencies.', 'This is a no-cost interest survey until a flight is confirmed.', 'Ticket sales are handled by a licensed travel agency.'],
  },
};

export default function CharterView() {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>('/v1/content/charter');
  const c = item(st.data);
  const title = str(c, 'title') || FALLBACK[lang].title;
  const lead = str(c, 'summary', 'lead', 'bodyMd', 'body') || FALLBACK[lang].lead;
  const routes = arr<any>(c, 'routes', 'campaigns', 'items', 'data.routes');
  const [form, setForm] = useState({ origin: '인천 (ICN)', destination: '', name: user?.displayName ?? '', email: user?.email ?? '', phone: '', note: '' });
  const [range, setRange] = useState({ start: '', end: '' });
  const [pax, setPax] = useState(2);
  const [consent, setConsent] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <section className="hero full-bleed" style={{ paddingBottom: 'var(--sp-12)' }}>
        <div className="container">
          <p className="eyebrow">WONT Travel Club · JETPOOL</p>
          <h1>{title}</h1>
          <p className="lead">{lead}</p>
          <div className="chip-group" style={{ marginTop: 16 }}>
            <span className="chip"><Icon name="plane" size={16} /> {L('사전 수요 접수', 'Interest list')}</span>
            <span className="chip">🛈 {L('직접 예약 아님', 'No direct booking')}</span>
          </div>
        </div>
      </section>
      <Alert tone="info">{L('현재 전세기 직접 예약·결제는 제공하지 않습니다. 상담 신청을 남겨주시면 노선 확정 시 등록 여행사를 통해 안내드립니다.', 'Direct charter booking is not offered. Leave a request and a licensed agency will contact you when a route is confirmed.')}</Alert>
      <div className="grid-2" style={{ marginTop: 24 }}>
        <div>
          <Section title={L('어떻게 진행되나요?', 'How it works')}>
            <ol className="stepper" style={{ marginTop: 8 }}>
              {[L('수요 신청', 'Request'), L('노선 검토', 'Route review'), L('운항 협의', 'Operator deal'), L('여행사 판매', 'Agency sale')].map((s, i) => (
                <li key={s} className={i === 0 ? 'current' : ''}><span className="dot">{i + 1}</span><span>{s}</span></li>
              ))}
            </ol>
            <ul className="stack" style={{ paddingLeft: 18 }}>{(arr<string>(c, 'points').length ? arr<string>(c, 'points') : FALLBACK[lang].points).map((p) => <li key={p}>{p}</li>)}</ul>
          </Section>
          {routes.length > 0 && (
            <Section title={L('모집 중인 노선', 'Open routes')}>
              <div className="grid">
                {routes.map((r: any, i: number) => (
                  <article key={i} className="card stack">
                    <strong>{str(r, 'title', 'route', 'name')}</strong>
                    <span className="small muted">{str(r, 'period', 'dates', 'summary')}</span>
                    {str(r, 'status') && <span className="badge info">{str(r, 'status')}</span>}
                  </article>
                ))}
              </div>
            </Section>
          )}
        </div>
        <aside className="card booking-card">
          {ok ? (
            <div className="state" style={{ border: 0 }}>
              <h2>✈️ {L('신청이 접수되었습니다', 'Request received')}</h2>
              <p className="muted">{L('노선이 확정되면 연락드릴게요.', 'We will contact you when a route is confirmed.')}</p>
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setErr(null);
                try {
                  await post('/v1/charter/requests', {
                    contactName: form.name,
                    contactEmail: form.email,
                    contactPhone: form.phone || undefined,
                    origin: form.origin,
                    destination: form.destination,
                    preferredDate: range.start || undefined,
                    partySize: pax,
                    message: [range.end ? `${L('귀국 희망일', 'Return')}: ${range.end}` : '', form.note].filter(Boolean).join('\n') || undefined,
                    website: '',
                  });
                  setOk(true);
                } catch (x) {
                  setErr(x);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h2 style={{ margin: 0 }}>{L('전세기 상담 신청', 'Charter interest form')}</h2>
              <div className="form-grid cols-2">
                <label className="field"><span>{L('출발지', 'From')}</span><input value={form.origin} onChange={set('origin')} required /></label>
                <label className="field"><span>{L('희망 목적지', 'To')}</span><input value={form.destination} onChange={set('destination')} required placeholder={L('예: 몽골 울란바토르', 'e.g. Ulaanbaatar')} /></label>
              </div>
              <DateRangeField start={range.start} end={range.end} onChange={setRange} labels={[L('출발', 'Depart'), L('귀국', 'Return')]} boxed />
              <div className="guest-row"><strong>{L('인원', 'Passengers')}</strong><Qty label={L('인원', 'Passengers')} value={pax} min={1} max={50} onChange={setPax} /></div>
              <div className="form-grid cols-2">
                <label className="field"><span>{L('이름', 'Name')}</span><input value={form.name} onChange={set('name')} required autoComplete="name" /></label>
                <label className="field"><span>{L('연락처', 'Phone')}</span><input value={form.phone} onChange={set('phone')} type="tel" autoComplete="tel" /></label>
              </div>
              <label className="field"><span>{L('이메일', 'Email')}</span><input value={form.email} onChange={set('email')} type="email" required autoComplete="email" /></label>
              <label className="field"><span>{L('요청 사항', 'Notes')}</span><textarea value={form.note} onChange={set('note')} /></label>
              <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required /><span>{L('[필수] 상담을 위한 개인정보 수집·이용(연락처, 희망 일정)에 동의합니다. 보관: 상담 종료 후 1년', '[Required] I consent to the use of my contact details for this enquiry (kept 1 year).')}</span></label>
              <button className="btn accent lg block" disabled={busy || !consent} data-loading={busy ? 'true' : undefined}>{L('상담 신청하기', 'Send request')}</button>
              <ErrorText error={err} />
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
