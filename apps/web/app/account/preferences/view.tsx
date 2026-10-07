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
        method="PUT"
        cols={2}
        fields={[
          { name: 'locale', label: L('언어', 'Locale'), type: 'select', options: [{ value: 'ko-KR', label: '한국어' }, { value: 'en-US', label: 'English' }] },
          { name: 'currency', label: L('표시 통화', 'Currency'), type: 'select', options: ['KRW', 'USD', 'JPY', 'EUR'].map((c) => ({ value: c, label: c })) },
          { name: 'timezone', label: L('시간대', 'Time zone'), placeholder: 'Asia/Seoul' },
          { name: 'travelStyle', label: L('여행 스타일', 'Travel style'), type: 'select', options: [{ value: 'MONTH_STAY', label: L('한달살기', 'Month stay') }, { value: 'SHORT', label: L('단기 여행', 'Short trip') }, { value: 'WORKATION', label: L('워케이션', 'Workation') }] },
          { name: 'personalizationOptIn', label: L('맞춤 추천 사용 (개인화)', 'Personalised recommendations'), type: 'checkbox' },
        ]}
      />
    </RequireAuth>
  );
}
