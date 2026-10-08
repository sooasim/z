'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { GUIDE_TYPES, GUIDE_TYPE_LABEL } from '@/lib/domain';
import { canonicalPlace, placeLabel } from '@/lib/places';
import { GuideCard } from '@/components/cards';
import { StateView, EmptyState } from '@/components/states';
import { Alert, Button, ButtonLink, ChipGroup, DestinationInput, HeadingLevel, PageHeader, Select } from '@/components/ui';
import { DateField } from '@/components/public/DateField';
import { useDebounced, useUrlSync } from '@/components/public/hooks';
import s from '@/components/public/public.module.css';

export default function GuideFriendsView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const [types, setTypes] = useState<string[]>(sp.getAll('type'));
  /** `area` is what the user sees ("서울"); `city` is the canonical API value ("Seoul"). */
  const [area, setArea] = useState(() => placeLabel(sp.get('q') ?? '', lang));
  const [picked, setPicked] = useState(() => canonicalPlace(sp.get('q') ?? ''));
  const [date, setDate] = useState(sp.get('date') ?? '');
  const [language, setLanguage] = useState(sp.get('language') ?? '');
  const typed = useDebounced(area.trim(), 300);
  const city = picked && canonicalPlace(typed) === picked ? picked : canonicalPlace(typed);
  useUrlSync({ q: city, type: types, date, language });
  const st = useApi<any>('/v1/search/guides', {
    query: { city: city || undefined, types: types.join(',') || undefined, languages: language || undefined, from: date ? `${date}T00:00:00+09:00` : undefined, to: date ? `${date}T23:59:59+09:00` : undefined, availableOnly: date ? 'true' : undefined, limit: 24 },
  });
  const filtered = !!(city || types.length || date || language);
  const clear = () => {
    setArea('');
    setPicked('');
    setTypes([]);
    setDate('');
    setLanguage('');
  };
  return (
    <>
      <PageHeader title={L('가이드 프렌드', 'Guide Friends')} subtitle={L('동네 친구처럼 함께 걷는 로컬. 무료 교류부터 전문 가이드까지.', 'Locals who show you around — from free friends to licensed pros.')} actions={<ButtonLink href="/guide/onboarding" icon="compass">{L('가이드로 활동하기', 'Become a guide')}</ButtonLink>} />
      <div className="card stack">
        <div className="form-grid cols-3">
          <div className={s.slotField}>
            <span className={s.lbl} aria-hidden="true">{L('지역', 'Area')}</span>
            <DestinationInput
              label={L('지역', 'Area')}
              value={area}
              onChange={(v) => {
                setArea(v);
                if (picked && canonicalPlace(v) !== picked) setPicked('');
              }}
              onPick={(v) => setPicked(v)}
              placeholder={L('서울, 제주, 해운대…', 'Seoul, Jeju…')}
            />
          </div>
          <DateField label={L('희망 날짜', 'Date')} value={date} onChange={setDate} placeholder={L('언제든', 'Any date')} />
          <Select
            label={L('언어', 'Language')}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            options={[
              { value: '', label: L('전체', 'Any') },
              { value: 'ko', label: L('한국어', 'Korean') },
              { value: 'en', label: L('영어', 'English') },
              { value: 'ja', label: L('일본어', 'Japanese') },
              { value: 'zh', label: L('중국어', 'Chinese') },
            ]}
          />
        </div>
        <ChipGroup multi label={L('가이드 유형', 'Guide type')} value={types} onChange={setTypes} options={GUIDE_TYPES.map((t) => ({ value: t, label: GUIDE_TYPE_LABEL[t][lang] }))} />
        <p className="small muted" style={{ margin: 0 }}>{L('프렌드·자원봉사는 무료 교류이며 금전 거래가 금지돼요. 유료·전문 가이드는 자격 확인 후 JETPOOL에서 결제해요.', 'Friend/volunteer meetups are free (no payments allowed). Paid/pro guides are verified and paid via JETPOOL.')}</p>
      </div>
      <div style={{ marginTop: 16 }}>
        <StateView
          state={st}
          skeleton="cards"
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState
              illo="search"
              title={city ? L(`${placeLabel(city, 'ko')}에서 조건에 맞는 가이드가 없어요`, `No guides match in ${placeLabel(city, 'en')}`) : L('조건에 맞는 가이드가 없어요', 'No guides match')}
              action={
                <>
                  {filtered && (
                    <Button variant="primary" onClick={clear}>
                      {L('조건 모두 지우기', 'Clear filters')}
                    </Button>
                  )}
                  <ButtonLink href="/guide/onboarding">{L('내가 가이드 되기', 'Become a guide')}</ButtonLink>
                </>
              }
            >
              {L('날짜나 유형을 바꿔 보세요. 새 가이드가 계속 합류하고 있어요.', 'Try another date or type — new guides join every week.')}
            </EmptyState>
          }
        >
          {(d) => (
            <HeadingLevel level={2}>
              <p className="small muted" aria-live="polite" style={{ margin: '0 0 12px' }}>
                {L(`가이드 ${items(d).length}명`, `${items(d).length} guides`)}
              </p>
              <div className="grid">
                {items(d).map((g: any, i) => (
                  <GuideCard key={g.id ?? g.guide?.guideId ?? i} g={g} />
                ))}
              </div>
            </HeadingLevel>
          )}
        </StateView>
      </div>
      {st.error ? null : (
        <div style={{ marginTop: 24 }}>
          <Alert tone="info">{L('만남은 공공장소에서 시작하고, 모든 연락은 JETPOOL 메시지로 남겨 주세요.', 'Meet in public places and keep communication in JETPOOL messages.')}</Alert>
        </div>
      )}
    </>
  );
}
