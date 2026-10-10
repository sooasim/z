'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { arr, item, str } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { fieldErrors } from '@/lib/errors';
import { Alert, Badge, Button, ErrorText, Section, DateRangeField, Qty, Icon, Illustration, Input, Textarea, type IconName } from '@/components/ui';
import { Markdown } from '@/components/public/Markdown';
import s from '@/components/public/public.module.css';
import Link from 'next/link';
import { charterPhotos, useMediaMap } from '@/lib/media';
import { Photo, PhotoCredit } from '@/components/media';
import m from '@/components/media/media.module.css';
import { pickText } from '@/lib/phrases';

const FALLBACK = {
  ko: {
    title: '전세기 공유 JETPOOL',
    lead: '같은 곳으로 떠나고 싶은 사람들이 모이면, 노선이 열립니다. WONT Travel Club에서 시작된 전세기 공유 여행을 JETPOOL에서 이어갑니다.',
    points: ['수요가 모이면 항공사·여행사와 전세기 운항을 협의해요.', '확정 전까지는 비용이 들지 않는 사전 수요 조사예요.', '항공권 판매와 발권은 등록된 여행사가 진행해요.'],
    sections: [
      { title: '플라이트 쉐어', body: '같은 노선을 원하는 여행자들과 좌석을 나누는 공유 운항 상담.' },
      { title: '단체 전세기', body: '동호회·기업 워크숍처럼 한 그룹이 함께 떠나는 전세기 상담.' },
      { title: '컨시어지', body: '숙소·가이드·투어까지 JETPOOL에서 하나의 여행으로 연결해요.' },
    ],
  },
  en: {
    title: 'Charter sharing JETPOOL',
    lead: 'When enough people want to go to the same place, a route opens. The charter sharing trips that began at WONT Travel Club continue on JETPOOL.',
    points: ['When demand gathers we negotiate charter operations with airlines and agencies.', 'This is a no-cost interest survey until a flight is confirmed.', 'Ticket sales are handled by a licensed travel agency.'],
    sections: [
      { title: 'Flight share', body: 'Share seats with travellers who want the same route.' },
      { title: 'Group charter', body: 'A whole plane for clubs, company offsites and groups.' },
      { title: 'Concierge', body: 'Stays, guides and tours joined up into one JETPOOL trip.' },
    ],
  },
};
const SECTION_ICON: IconName[] = ['users', 'plane', 'sparkle'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Real charter / jet photos (media map 'charter' set) behind the hero. */
function CharterHeroPhoto() {
  useMediaMap();
  const src = charterPhotos()[0];
  if (!src) return null;
  return (
    <div className={m.heroPhoto} aria-hidden="true">
      <Photo src={src} alt="" eager sizes="100vw" />
      <PhotoCredit src={src} style={{ top: 10, bottom: 'auto' }} />
    </div>
  );
}

export default function CharterView() {
  const { L, lang } = useI18n();
  useMediaMap();
  const photos = charterPhotos();
  const { user } = useAuth();
  const st = useApi<any>('/v1/content/charter');
  const c = item(st.data);
  // CMS copy is authored per locale: use it only when it matches the UI language, else the bilingual fallback.
  const sameLocale = !!c && (str(c, 'locale') || 'ko-KR').toLowerCase().startsWith(lang);
  // FALLBACK holds nested copy objects, not strings: Korean reads its own tree, every other language reads
  // the English one (long-form marketing copy is not in the phrase table — see docs/I18N.md).
  const fb = lang === 'ko' ? FALLBACK.ko : FALLBACK.en;
  const title = (sameLocale && str(c, 'title')) || fb.title;
  const lead = (sameLocale && str(c, 'summary', 'lead')) || fb.lead;
  const body = sameLocale ? str(c, 'bodyMd', 'body') : '';
  const sections = sameLocale && arr<any>(c, 'sections').length ? arr<any>(c, 'sections').map((x: any) => ({ title: str(x, 'title'), body: str(x, 'body') })) : fb.sections;
  const routes = sameLocale ? arr<any>(c, 'routes', 'campaigns', 'items', 'data.routes') : [];
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState({ origin: L('인천 (ICN)', 'Incheon (ICN)'), destination: '', name: user?.displayName ?? '', email: user?.email ?? '', phone: '', note: '' });
  const [range, setRange] = useState({ start: '', end: '' });
  const [pax, setPax] = useState(2);
  const [consent, setConsent] = useState(false);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const touched = useRef<Set<string>>(new Set());
  // Defaults follow the UI language and the signed-in profile until the user edits those fields.
  useEffect(() => {
    setForm((f) => ({
      ...f,
      origin: touched.current.has('origin') ? f.origin : L('인천 (ICN)', 'Incheon (ICN)'),
      name: touched.current.has('name') || !user ? f.name : user.displayName,
      email: touched.current.has('email') || !user ? f.email : user.email,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, user?.id]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    touched.current.add(k);
    setForm({ ...form, [k]: e.target.value });
    if (fe[k]) setFe((x) => ({ ...x, [k]: '' }));
  };
  const server = fieldErrors(err, lang);
  const errOf = (k: string, apiKey?: string) => fe[k] || server[apiKey ?? k] || '';
  const hint = (k: string, apiKey?: string, h?: string) => (errOf(k, apiKey) ? <span className={s.err}>{errOf(k, apiKey)}</span> : h);
  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.origin.trim()) e.origin = L('출발지를 입력해 주세요.', 'Enter where you fly from.');
    if (!form.destination.trim()) e.destination = L('가고 싶은 곳을 입력해 주세요.', 'Enter where you want to go.');
    if (!form.name.trim()) e.name = L('이름을 입력해 주세요.', 'Enter your name.');
    if (!form.email.trim()) e.email = L('연락받을 이메일을 입력해 주세요.', 'Enter an email we can reach you at.');
    else if (!EMAIL_RE.test(form.email.trim())) e.email = L('이메일 형식이 올바르지 않아요.', 'Check the email format.');
    if (form.phone && !/^[\d+\-\s()]{8,20}$/.test(form.phone)) e.phone = L('전화번호는 숫자와 -만 입력해 주세요.', 'Use digits and dashes only.');
    if (!consent) e.consent = L('개인정보 수집·이용에 동의해야 신청할 수 있어요.', 'Consent is required to send the request.');
    return e;
  };
  return (
    <>
      <section className="hero full-bleed" style={{ paddingBottom: 'var(--sp-12)' }}>
        <CharterHeroPhoto />
        <div className="container">
          <p className="eyebrow">WONT Travel Club · JETPOOL</p>
          <h1>{title}</h1>
          <p className="lead">{lead}</p>
          <div className="row" style={{ marginTop: 16, gap: 8 }}>
            <Badge tone="solid" icon={<Icon name="plane" size={14} />}>
              {L('사전 수요 접수 중', 'Collecting interest')}
            </Badge>
            <Badge tone="solid" icon={<Icon name="info" size={14} />}>
              {L('직접 예약·결제 아님', 'No direct booking')}
            </Badge>
          </div>
        </div>
      </section>
      <div style={{ marginTop: 'var(--sp-6)' }}>
        <Alert tone="info">{L('현재 전세기 직접 예약·결제는 제공하지 않아요. 상담을 신청하시면 노선이 확정될 때 등록 여행사를 통해 안내해 드려요.', 'Direct charter booking is not offered. Leave a request and a licensed agency will contact you when a route is confirmed.')}</Alert>
      </div>
      <div className="grid-2" style={{ marginTop: 24 }}>
        <div>
          <Section title={L('어떻게 진행되나요?', 'How it works')}>
            <ol className="stepper" style={{ marginTop: 8 }}>
              {[L('수요 신청', 'Request'), L('노선 검토', 'Route review'), L('운항 협의', 'Operator deal'), L('여행사 판매', 'Agency sale')].map((t, i) => (
                <li key={t} className={i === 0 ? 'current' : ''}>
                  <span className="dot">{i + 1}</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
            {body ? (
              <Markdown source={body} compact baseLevel={3} />
            ) : (
              <ul className={s.check}>
                {(sameLocale && arr<string>(c, 'points').length ? arr<string>(c, 'points') : fb.points).map((p) => (
                  <li key={p}>
                    <Icon name="check-circle" size={18} style={{ color: 'var(--success)' }} /> <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={L('이런 상담을 받아요', 'What we can arrange')}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))' }}>
              {sections.map((x, i) => (
                <article key={x.title} className="card flat stack" style={{ overflow: 'hidden' }}>
                  {photos[i + 1] && (
                    <div style={{ margin: 'calc(-1 * var(--sp-5)) calc(-1 * var(--sp-5)) 0', aspectRatio: '16 / 10', overflow: 'hidden', position: 'relative' }}>
                      <Photo src={photos[i + 1]} alt="" sizes="(max-width: 640px) 92vw, 300px" style={{ width: '100%', height: '100%' }} />
                      <PhotoCredit src={photos[i + 1]} />
                    </div>
                  )}
                  <span className={s.icoTile} aria-hidden="true">
                    <Icon name={SECTION_ICON[i % SECTION_ICON.length]} size={20} />
                  </span>
                  <h3 style={{ margin: 0 }}>{x.title}</h3>
                  <p className="small muted" style={{ margin: 0 }}>{x.body}</p>
                </article>
              ))}
            </div>
          </Section>
          <p className="small" style={{ marginTop: 'var(--sp-4)' }}>
            <Link href="/about/charter-platform">{L('원여행클럽의 전세기 공유 플랫폼 이야기', 'The WONT charter sharing story')}</Link>
            {' · '}
            <Link href="/about/about-jetpool">{L('젯풀인터내셔날 · 특허', 'JETPOOL International & patent')}</Link>
          </p>
          {routes.length > 0 && (
            <Section title={L('모집 중인 노선', 'Open routes')}>
              <div className="grid">
                {routes.map((r: any, i: number) => (
                  <article key={i} className="card stack">
                    <strong>{str(r, 'title', 'route', 'name')}</strong>
                    <span className="small muted">{str(r, 'period', 'dates', 'summary')}</span>
                  </article>
                ))}
              </div>
            </Section>
          )}
        </div>
        <aside className={`card booking-card sticky-cta ${s.aside}`} aria-label={L('전세기 상담 신청', 'Charter interest form')}>
          {ok ? (
            <div className="center stack" role="status">
              <Illustration name="trips" />
              <h2 style={{ margin: 0 }}>{L('신청이 접수되었어요', 'Request received')}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {L(`${form.destination} 노선 수요에 추가했어요. 운항이 확정되면 ${form.email}로 연락드릴게요.`, `We added you to the ${form.destination} route list and will email ${form.email} when a flight is confirmed.`)}
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  setOk(false);
                  setForm((f) => ({ ...f, destination: '', note: '' }));
                  setRange({ start: '', end: '' });
                }}
              >
                {L('다른 노선도 신청하기', 'Request another route')}
              </Button>
            </div>
          ) : (
            <form
              ref={formRef}
              className="stack"
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const v = validate();
                setFe(v);
                if (Object.keys(v).length) {
                  requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
                  return;
                }
                setBusy(true);
                setErr(null);
                try {
                  await post('/v1/charter/requests', {
                    contactName: form.name.trim(),
                    contactEmail: form.email.trim(),
                    contactPhone: form.phone || undefined,
                    origin: form.origin.trim(),
                    destination: form.destination.trim(),
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
              <div>
                <h2 style={{ margin: 0 }}>{L('전세기 상담 신청', 'Charter interest form')}</h2>
                <p className="xs muted" style={{ margin: '4px 0 0' }}>
                  <span aria-hidden="true">*</span> {L('표시는 필수 항목이에요.', 'marks required fields.')}
                </p>
              </div>
              <div className="form-grid cols-2">
                <Input label={L('출발지', 'From')} value={form.origin} onChange={set('origin')} required aria-invalid={errOf('origin') ? true : undefined} hint={hint('origin')} />
                <Input label={L('희망 목적지', 'To')} value={form.destination} onChange={set('destination')} required placeholder={L('예: 몽골 울란바토르', 'e.g. Ulaanbaatar')} aria-invalid={errOf('destination') ? true : undefined} hint={hint('destination')} />
              </div>
              <div className={`${s.slotField} ${s.showK}`}>
                <span className={s.lbl}>{L('희망 일정 (선택)', 'Preferred dates (optional)')}</span>
                <DateRangeField start={range.start} end={range.end} onChange={setRange} labels={[L('출발', 'Depart'), L('귀국', 'Return')]} align="right" />
                {range.start && range.end && <small className="hint xs muted">{formatRange(range.start, range.end, lang, { nights: true })}</small>}
              </div>
              <div className="guest-row" style={{ paddingTop: 4 }}>
                <strong>{L('인원', 'Passengers')}</strong>
                <Qty label={L('인원', 'Passengers')} value={pax} min={1} max={300} onChange={setPax} />
              </div>
              <div className="form-grid cols-2">
                <Input label={L('이름', 'Name')} value={form.name} onChange={set('name')} required autoComplete="name" aria-invalid={errOf('name', 'contactName') ? true : undefined} hint={hint('name', 'contactName')} />
                <Input label={L('연락처 (선택)', 'Phone (optional)')} value={form.phone} onChange={set('phone')} type="tel" inputMode="tel" autoComplete="tel" placeholder="010-1234-5678" aria-invalid={errOf('phone', 'contactPhone') ? true : undefined} hint={hint('phone', 'contactPhone')} />
              </div>
              <Input label={L('이메일', 'Email')} value={form.email} onChange={set('email')} type="email" inputMode="email" required autoComplete="email" aria-invalid={errOf('email', 'contactEmail') ? true : undefined} hint={hint('email', 'contactEmail', L('노선이 확정되면 이 주소로 연락드려요.', 'We’ll contact you here when a route is confirmed.'))} />
              <Textarea label={L('요청 사항 (선택)', 'Notes (optional)')} value={form.note} onChange={set('note')} maxLength={2000} placeholder={L('단체명, 희망 좌석 등급, 숙소·투어 연계 여부 등', 'Group name, cabin, whether you also need stays or tours…')} />
              <div>
                <label className="check">
                  <input type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); if (e.target.checked) setFe((x) => ({ ...x, consent: '' })); }} aria-invalid={fe.consent ? true : undefined} aria-describedby={fe.consent ? 'consent-e' : undefined} />
                  <span>{L('[필수] 상담을 위한 개인정보 수집·이용(이름, 연락처, 희망 일정)에 동의합니다. 보관 기간: 상담 종료 후 1년', '[Required] I consent to the use of my contact details for this enquiry (kept 1 year).')}</span>
                </label>
                {fe.consent && (
                  <small id="consent-e" className={`xs ${s.err}`}>
                    {fe.consent}
                  </small>
                )}
              </div>
              <Button type="submit" variant="accent" size="lg" block loading={busy}>
                {L('상담 신청하기', 'Send request')}
              </Button>
              <ErrorText error={err} />
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
