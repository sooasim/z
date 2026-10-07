'use client';
import { useI18n } from '@/lib/i18n';
import { RequireAuth } from '@/components/gate';
import { ResourceForm } from '@/components/form';
import { PageHeader } from '@/components/ui';

export default function PreferencesView() {
  const { L, lang, setLang } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('환경설정', 'Preferences')} />
      <div className="card row between" style={{ marginBottom: 16 }}>
        <span>{L('화면 언어 (이 기기)', 'Display language (this device)')}</span>
        <div className="chip-group">
          <button className="chip" aria-pressed={lang === 'ko'} onClick={() => setLang('ko')}>한국어</button>
          <button className="chip" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
        </div>
      </div>
      <ResourceForm
        path="/v1/me/preferences"
        method="PATCH"
        cols={2}
        fields={[
          { name: 'currency', label: L('표시 통화', 'Currency'), type: 'select', options: ['KRW', 'USD', 'JPY', 'EUR'].map((c) => ({ value: c, label: c })) },
          { name: 'travelStyles', label: L('여행 스타일 (쉼표 구분)', 'Travel styles (comma separated)'), type: 'list', placeholder: L('한달살기, 워케이션', 'month-stay, workation') },
          { name: 'interests', label: L('관심사 (쉼표 구분)', 'Interests'), type: 'list', placeholder: L('카페, 바다, 등산', 'cafes, sea, hiking') },
          { name: 'personalizationOptOut', label: L('맞춤 추천 끄기 (개인화 거부)', 'Opt out of personalisation'), type: 'checkbox' },
          { name: 'marketingOptIn', label: L('혜택·마케팅 수신', 'Marketing messages'), type: 'checkbox' },
        ]}
      />
    </RequireAuth>
  );
}
