'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { GUIDE_TYPES, GUIDE_TYPE_LABEL } from '@/lib/domain';
import { isoDate } from '@/lib/format';
import { GuideCard } from '@/components/cards';
import { StateView, EmptyState } from '@/components/states';
import { ChipGroup, PageHeader, Alert } from '@/components/ui';
import Link from 'next/link';

export default function GuideFriendsView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const [types, setTypes] = useState<string[]>(sp.getAll('type'));
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [date, setDate] = useState(sp.get('date') ?? '');
  const [language, setLanguage] = useState(sp.get('language') ?? '');
  const st = useApi<any>('/v1/search/guides', { query: { city: q || undefined, types: types.join(',') || undefined, languages: language || undefined, from: date ? `${date}T00:00:00+09:00` : undefined, to: date ? `${date}T23:59:59+09:00` : undefined, availableOnly: date ? 'true' : undefined, limit: 24 } });
  return (
    <>
      <PageHeader title={L('가이드 프렌드', 'Guide Friends')} subtitle={L('동네 친구처럼 함께 걷는 로컬. 무료 교류부터 전문 가이드까지.', 'Locals who show you around — from free friends to licensed pros.')} actions={<Link className="btn" href="/guide/onboarding">{L('가이드로 활동하기', 'Become a guide')}</Link>} />
      <div className="card stack">
        <div className="form-grid cols-4">
          <label className="field"><span>{L('지역', 'Area')}</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('성수동, 해운대…', 'Seongsu, Haeundae…')} /></label>
          <label className="field"><span>{L('희망 날짜', 'Date')}</span><input type="date" min={isoDate(new Date())} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field"><span>{L('언어', 'Language')}</span><select value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">{L('전체', 'Any')}</option><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label>
        </div>
        <ChipGroup multi label={L('가이드 유형', 'Guide type')} value={types} onChange={setTypes} options={GUIDE_TYPES.map((t) => ({ value: t, label: GUIDE_TYPE_LABEL[t][lang] }))} />
        <p className="small muted" style={{ margin: 0 }}>{L('프렌드·자원봉사는 무료 교류이며 금전 거래가 금지됩니다. 유료·전문 가이드는 자격 확인 후 결제가 가능합니다.', 'Friend/volunteer meetups are free (no payments allowed). Paid/pro guides are verified and paid via JETPOOL.')}</p>
      </div>
      <div style={{ marginTop: 16 }}>
        <StateView state={st} skeleton="cards" isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="search" title={L('조건에 맞는 가이드가 없습니다.', 'No guides match.')} />}>
          {(d) => (
            <div className="grid">
              {items(d).map((g: any, i) => (
                <GuideCard key={g.id ?? i} g={g} />
              ))}
            </div>
          )}
        </StateView>
      </div>
      {st.error ? null : <Alert tone="info">{L('만남은 공공장소에서 시작하고, 모든 연락은 JETPOOL 메시지로 남겨 주세요.', 'Meet in public places and keep communication in JETPOOL messages.')}</Alert>}
    </>
  );
}
