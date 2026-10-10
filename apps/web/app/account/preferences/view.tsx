'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { LANGS } from '@/lib/langs';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { item, str, f } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Button, ErrorText, PageHeader, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ChipsInput, Switch, styles as s } from '@/components/traveler/ui';
import { pickPair } from '@/lib/phrases';

const STYLES: Record<string, [string, string]> = {
  'month-stay': ['한달살기', 'Month-long stays'],
  workation: ['워케이션', 'Workation'],
  'local-life': ['로컬 라이프', 'Local life'],
  family: ['가족 여행', 'Family trips'],
  couple: ['커플 여행', 'Couples'],
  solo: ['혼자 여행', 'Solo travel'],
  'pet-friendly': ['반려동물 동반', 'With pets'],
  slow: ['느린 여행', 'Slow travel'],
  luxury: ['럭셔리', 'Luxury'],
  budget: ['가성비', 'Budget'],
};
const INTERESTS: Record<string, [string, string]> = {
  food: ['미식', 'Food'],
  cafe: ['카페', 'Cafés'],
  nature: ['자연', 'Nature'],
  history: ['역사', 'History'],
  hiking: ['등산', 'Hiking'],
  sea: ['바다', 'Sea'],
  art: ['예술', 'Art'],
  walking: ['산책', 'Walking'],
  shopping: ['쇼핑', 'Shopping'],
  festival: ['축제', 'Festivals'],
  'k-culture': ['K-컬처', 'K-culture'],
  surfing: ['서핑', 'Surfing'],
};
const CURRENCIES: Array<[string, string, string]> = [
  ['KRW', '원 (₩)', 'Korean won (₩)'],
  ['USD', '미국 달러 ($)', 'US dollar ($)'],
  ['JPY', '일본 엔 (¥)', 'Japanese yen (¥)'],
  ['EUR', '유로 (€)', 'Euro (€)'],
];

function Form({ p, onSaved }: { p: any; onSaved: (x: any) => void }) {
  const { L, lang } = useI18n();
  const toast = useToast();
  const [currency, setCurrency] = useState(str(p, 'currency') || 'KRW');
  const [styles, setStyles] = useState<string[]>((f<string[]>(p, 'travelStyles') ?? []) as string[]);
  const [interests, setInterests] = useState<string[]>((f<string[]>(p, 'interests') ?? []) as string[]);
  const [optOut, setOptOut] = useState(f(p, 'personalizationOptOut') === true);
  const [marketing, setMarketing] = useState(f(p, 'marketingOptIn') === true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const label = (map: Record<string, [string, string]>) => (v: string) => pickPair(map[v], lang) ?? v;
  return (
    <form
      className="stack-lg"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const r = await api('/v1/me/preferences', { method: 'PATCH', body: { currency, travelStyles: styles, interests, personalizationOptOut: optOut, marketingOptIn: marketing } });
          onSaved(item(r) ?? r);
          toast.show(L('환경설정을 저장했어요', 'Preferences saved'));
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <section className="card stack">
        <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{L('표시 통화', 'Display currency')}</h2>
        <div style={{ maxWidth: 360 }}>
          <Select label={L('가격을 볼 통화', 'Show prices in')} value={currency} onChange={(e) => setCurrency(e.target.value)} options={CURRENCIES.map(([v, ko, en]) => ({ value: v, label: lang === 'ko' ? ko : en }))} />
        </div>
        <p className="xs muted" style={{ margin: 0 }}>{L('결제는 숙소·상품의 판매 통화로 진행돼요. 표시 통화는 참고용 환산이에요.', 'You’re charged in the listing’s currency; this is for display only.')}</p>
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{L('여행 취향', 'Travel taste')}</h2>
        <p className="small muted" style={{ margin: 0 }}>{L('고른 취향에 맞춰 숙소와 가이드를 추천해 드려요.', 'We use these to recommend stays and guides.')}</p>
        <ChipsInput label={L('여행 스타일', 'Travel style')} value={styles} onChange={setStyles} suggestions={Object.keys(STYLES)} labelOf={label(STYLES)} placeholder={L('직접 입력 후 Enter', 'Type and press Enter')} max={20} />
        <ChipsInput label={L('관심사', 'Interests')} value={interests} onChange={setInterests} suggestions={Object.keys(INTERESTS)} labelOf={label(INTERESTS)} placeholder={L('직접 입력 후 Enter', 'Type and press Enter')} max={50} />
      </section>
      <fieldset className={`card ${s.fieldset}`}>
        <legend>{L('맞춤 추천 · 마케팅', 'Personalization & marketing')}</legend>
        <div className="row between nowrap" style={{ gap: 16 }}>
          <div>
            <strong className="small" id="p-optout">{L('맞춤 추천 끄기', 'Turn off personalized recommendations')}</strong>
            <p className="xs muted" style={{ margin: '2px 0 0' }} id="p-optout-d">{L('켜면 이용 기록을 추천에 사용하지 않아요. 검색 결과는 인기순으로 보여요.', 'When on, your activity isn’t used for recommendations.')}</p>
          </div>
          <Switch checked={optOut} onChange={setOptOut} label={L('맞춤 추천 끄기', 'Turn off personalized recommendations')} describedBy="p-optout-d" />
        </div>
        <div className="row between nowrap" style={{ gap: 16 }}>
          <div>
            <strong className="small">{L('혜택·마케팅 수신', 'Offers & marketing')}</strong>
            <p className="xs muted" style={{ margin: '2px 0 0' }} id="p-mkt-d">{L('할인과 이벤트 소식을 이메일·앱 알림으로 받아요. 언제든 끌 수 있어요.', 'Get deals and events by email and in-app. Turn off anytime.')}</p>
          </div>
          <Switch checked={marketing} onChange={setMarketing} label={L('혜택·마케팅 수신', 'Offers & marketing')} describedBy="p-mkt-d" />
        </div>
      </fieldset>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy}>
          {L('저장', 'Save')}
        </Button>
      </div>
      <ErrorText error={err} />
    </form>
  );
}

export default function PreferencesView() {
  const { L, lang, setLang, auto, t } = useI18n();
  const st = useApi<any>('/v1/me/preferences', { auth: true });
  return (
    <RequireAuth>
      <PageHeader title={L('환경설정', 'Preferences')} subtitle={L('언어, 통화, 여행 취향을 설정하세요.', 'Language, currency and travel taste.')} />
      <section className="card row between" style={{ marginBottom: 24 }}>
        <div>
          <strong>{L('화면 언어', 'Display language')}</strong>
          <p className="xs muted" style={{ margin: '2px 0 0' }}>{L('이 기기에만 적용돼요.', 'Applies to this device.')}</p>
        </div>
        <div className="chip-group" role="group" aria-label={L('화면 언어', 'Display language')}>
          {LANGS.map((l) => (
            <button key={l.code} type="button" className="chip" aria-pressed={!auto && lang === l.code} onClick={() => setLang(l.code)} lang={l.locale} title={l.english}>
              {l.endonym}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={auto} onClick={() => setLang(null)}>
            {t('lang.auto')}
          </button>
        </div>
      </section>
      <StateView state={st}>{(d) => <Form p={item(d)} onSaved={(x) => st.setData({ item: x })} />}</StateView>
    </RequireAuth>
  );
}
