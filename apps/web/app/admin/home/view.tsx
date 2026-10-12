'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { f, items, str } from '@/lib/shape';
import { StateView } from '@/components/states';
import { Alert, Button, Checkbox, ErrorText, Input, PageHeader, Section, Select, StatusBadge, Textarea } from '@/components/ui';
import {
  HOME_SLUG,
  RAIL_KEYS,
  emptyHomeConfig,
  readHomeConfig,
  writeHomeConfig,
  type HomeConfig,
  type HomeRailConfig,
  type RailKey,
} from '@/lib/home';

/**
 * ADMIN · the main page (`/`).
 *
 * The home page is content, not layout: this screen writes the override set documented in `lib/home.ts` into
 * the CMS `PAGE` entry `home` for one locale, so it goes through the same draft → published transition,
 * admin-action audit trail and locale fallback as every other CMS entry. A field left blank keeps the home
 * page's built-in copy, which `lib/phrases.ts` renders in all five UI languages — so blanking a field is how
 * you *undo* an override, not how you hide a heading.
 */

const LOCALES: Array<{ value: string; label: string }> = [
  { value: 'ko-KR', label: '한국어 (ko-KR)' },
  { value: 'en-US', label: 'English (en-US)' },
  { value: 'ja-JP', label: '日本語 (ja-JP)' },
  { value: 'zh-CN', label: '简体中文 (zh-CN)' },
  { value: 'vi-VN', label: 'Tiếng Việt (vi-VN)' },
];

/** Repeating group of rows with add / remove / reorder. */
function Repeater<T>({ rows, onChange, blank, addLabel, row, emptyHint }: { rows: T[]; onChange: (rows: T[]) => void; blank: () => T; addLabel: string; row: (v: T, set: (patch: Partial<T>) => void, i: number) => ReactNode; emptyHint?: ReactNode }) {
  const { L } = useI18n();
  const move = (i: number, by: number) => {
    const next = [...rows];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="stack">
      {rows.length === 0 && emptyHint && <p className="small muted" style={{ margin: 0 }}>{emptyHint}</p>}
      {rows.map((v, i) => (
        <div key={i} className="card flat stack" style={{ padding: 'var(--sp-4)' }}>
          <div className="form-grid cols-2">{row(v, (patch) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}</div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="ghost" aria-label={L('위로 옮기기', 'Move up')} disabled={i === 0} onClick={() => move(i, -1)}>
              <span aria-hidden="true">↑</span>
            </Button>
            <Button size="sm" variant="ghost" aria-label={L('아래로 옮기기', 'Move down')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              <span aria-hidden="true">↓</span>
            </Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              {L('삭제', 'Remove')}
            </Button>
          </div>
        </div>
      ))}
      <div className="row">
        <Button size="sm" icon="plus" onClick={() => onChange([...rows, blank()])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

const RAIL_LABEL: Record<RailKey, [string, string]> = {
  stays: ['지금 예약 가능한 숙소', 'Stays you can book now'],
  exchange: ['홈 맞교환 가능한 집', 'Homes open to exchange'],
  guides: ['로컬 가이드 프렌드', 'Local guide friends'],
  tours: ['투어·티켓·패키지', 'Tours, tickets & packages'],
};

export default function AdminHomeView() {
  const { L, lang } = useI18n();
  const [locale, setLocale] = useState('ko-KR');
  const st = useApi<any>('/v1/admin/cms/entries', { query: { type: 'PAGE', limit: 200 }, auth: true });
  const entry = useMemo(() => items(st.data).find((e: any) => str(e, 'slug') === HOME_SLUG && str(e, 'locale') === locale) ?? null, [st.data, locale]);
  const entryId = str(entry, 'id');
  const status = str(entry, 'status').toUpperCase();

  const [cfg, setCfg] = useState<HomeConfig>(emptyHomeConfig);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  /** Re-seed from the server, but never over edits in progress (a language switch or a reload refetches). */
  const dirty = useRef(false);
  const seed = () => {
    dirty.current = false;
    setCfg(entry ? readHomeConfig(f(entry, 'data')) : emptyHomeConfig());
  };
  useEffect(() => {
    if (!dirty.current) seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, locale, st.data]);

  const set = (patch: Partial<HomeConfig>) => {
    dirty.current = true;
    setCfg((c) => ({ ...c, ...patch }));
    setSaved(false);
  };
  const setRail = (k: RailKey, patch: Partial<HomeRailConfig>) => set({ rails: { ...cfg.rails, [k]: { ...cfg.rails[k], ...patch } } });

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
      dirty.current = false; // saved: the entry the reload brings back is now the source of truth
      st.reload();
      setSaved(what === 'save');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy('');
    }
  };

  const save = () =>
    run('save', () => {
      const data = writeHomeConfig(cfg);
      if (entryId) return api(`/v1/admin/cms/entries/${entryId}`, { method: 'PATCH', body: { data } });
      return post('/v1/admin/cms/entries', { type: 'PAGE', slug: HOME_SLUG, locale, title: L('메인 첫 페이지', 'Main page'), summary: L('메인 첫 페이지에 표시되는 문구와 섹션', 'Copy and sections shown on the main page'), data });
    });

  return (
    <>
      <PageHeader
        title={L('메인 첫 페이지', 'Main page')}
        subtitle={L('메인 첫 페이지(/)의 히어로 문구, 바로가기, 추천 여행지, 섹션 노출, 브랜드 블록, 안심 약속을 편집합니다.', 'Edit the hero copy, shortcuts, featured destinations, section visibility, brand blocks and safety promise on the main page (/).')}
        actions={
          <>
            <Link className="btn ghost" href="/" target="_blank" rel="noreferrer">
              {L('첫 페이지 열기', 'Open the page')}
            </Link>
            <Button variant="primary" icon="check" loading={busy === 'save'} onClick={save}>
              {L('저장', 'Save')}
            </Button>
          </>
        }
      />

      <StateView state={st}>
        {() => (
          <>
            <Section>
              <div className="form-grid cols-2">
                <Select
                  label={L('편집할 언어', 'Language being edited')}
                  value={locale}
                  onChange={(e) => {
                    dirty.current = false; // switching language loads that locale's entry
                    setLocale(e.target.value);
                  }}
                  options={LOCALES}
                />
                <div className="field">
                  <span>{L('상태', 'Status')}</span>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    {entryId ? <StatusBadge status={status} /> : <span className="pill warn">{L('아직 없음', 'Not created yet')}</span>}
                    {entryId && status !== 'PUBLISHED' && (
                      <Button size="sm" variant="primary" loading={busy === 'publish'} onClick={() => run('publish', () => post(`/v1/admin/cms/entries/${entryId}/publish`, {}))}>
                        {L('게시', 'Publish')}
                      </Button>
                    )}
                    {entryId && status === 'PUBLISHED' && (
                      <Button size="sm" loading={busy === 'unpublish'} onClick={() => run('unpublish', () => post(`/v1/admin/cms/entries/${entryId}/unpublish`, {}))}>
                        {L('내리기 (기본 문구로 복귀)', 'Unpublish (back to defaults)')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              <Alert tone="info">
                {L(
                  '비워 둔 항목은 기본 문구가 그대로 쓰이고, 기본 문구는 5개 언어로 번역되어 있습니다. 여기서 입력한 문구는 선택한 언어에서만 쓰이므로, 꼭 필요한 항목만 바꿔 주세요. 변경은 게시(PUBLISHED) 후에 첫 페이지에 반영됩니다.',
                  'A field left blank keeps the built-in copy, which is translated into all five UI languages. Text you type here applies to the selected language only, so override just what you need. Changes reach the main page once the entry is published.',
                )}
              </Alert>
              {saved && (
                <Alert tone="ok">
                  {status === 'PUBLISHED'
                    ? L('저장했습니다. 첫 페이지에 바로 반영됩니다.', 'Saved — live on the main page now.')
                    : L('저장했습니다. 아직 초안이므로 게시해야 첫 페이지에 반영됩니다.', 'Saved as a draft — publish it to show it on the main page.')}
                </Alert>
              )}
              <ErrorText error={err} />
            </Section>

            <Section title={L('히어로 (첫 화면)', 'Hero')}>
              <div className="form-grid">
                <Input label={L('윗줄 (eyebrow)', 'Eyebrow')} value={cfg.hero.eyebrow} placeholder={L('살아보는 여행의 시작', 'Travel like a local')} onChange={(e) => set({ hero: { ...cfg.hero, eyebrow: e.target.value } })} />
                <Input label={L('큰 제목', 'Headline')} value={cfg.hero.title} placeholder={L('한 달, 다른 도시에서 살아보기', 'Live a month somewhere new')} onChange={(e) => set({ hero: { ...cfg.hero, title: e.target.value } })} />
                <Textarea label={L('설명', 'Lead paragraph')} rows={3} value={cfg.hero.lead} onChange={(e) => set({ hero: { ...cfg.hero, lead: e.target.value } })} />
              </div>
            </Section>

            <Section title={L('바로가기 칩', 'Shortcut chips')}>
              <Repeater
                rows={cfg.shortcuts}
                onChange={(shortcuts) => set({ shortcuts })}
                blank={() => ({ label: '', href: '/', icon: '' as const })}
                addLabel={L('바로가기 추가', 'Add shortcut')}
                emptyHint={L('비워 두면 기본 바로가기 3개(지도 · 맞교환 등록 · AI 추천)가 표시됩니다.', 'Leave empty for the three default shortcuts (map, list your home, plan with AI).')}
                row={(v, patch) => (
                  <>
                    <Input label={L('문구', 'Label')} value={v.label} onChange={(e) => patch({ label: e.target.value })} />
                    <Input label={L('링크', 'Link')} value={v.href} placeholder="/map" onChange={(e) => patch({ href: e.target.value })} />
                    <Input label={L('아이콘 이름', 'Icon name')} value={v.icon} placeholder="map" hint={L('예: map, swap, sparkle, ticket, compass', 'e.g. map, swap, sparkle, ticket, compass')} onChange={(e) => patch({ icon: e.target.value as typeof v.icon })} />
                  </>
                )}
              />
            </Section>

            <Section title={L('추천 여행지', 'Featured destinations')}>
              <Repeater
                rows={cfg.destinations}
                onChange={(destinations) => set({ destinations })}
                blank={() => ({ name: '', label: '', tag: '', image: '' })}
                addLabel={L('여행지 추가', 'Add destination')}
                emptyHint={L('비워 두면 기본 도시 8곳(제주·부산·강릉·서울·경주·치앙마이·도쿄·리스본)이 표시됩니다.', 'Leave empty for the eight default cities (Jeju, Busan, Gangneung, Seoul, Gyeongju, Chiang Mai, Tokyo, Lisbon).')}
                row={(v, patch) => (
                  <>
                    <Input label={L('도시 (영문, 검색에 사용)', 'City (English, used for search)')} value={v.name} placeholder="Jeju" onChange={(e) => patch({ name: e.target.value })} />
                    <Input label={L('카드에 보일 이름', 'Card label')} value={v.label} placeholder={L('제주', 'Jeju')} onChange={(e) => patch({ label: e.target.value })} />
                    <Input label={L('태그', 'Tag')} value={v.tag} placeholder={L('한달살기 1위', '#1 month stay')} onChange={(e) => patch({ tag: e.target.value })} />
                    <Input label={L('사진 주소 (선택)', 'Photo URL (optional)')} value={v.image} hint={L('비워 두면 도시 사진을 자동으로 고릅니다.', 'Left blank, a photo of the city is picked automatically.')} onChange={(e) => patch({ image: e.target.value })} />
                  </>
                )}
              />
            </Section>

            <Section title={L('목록 섹션', 'List sections')}>
              <p className="small muted" style={{ marginTop: 0 }}>
                {L(
                  '첫 페이지 중간의 가로 스크롤 목록입니다. 체크를 해제하면 섹션이 숨겨집니다. 노출 여부는 문구와 달리 모든 언어에 적용되므로, 언어별 콘텐츠를 여러 개 만들었다면 모두 같게 맞춰 주세요.',
                  'The horizontal rails in the middle of the page. Uncheck to hide a section. Unlike the copy, show/hide applies in every language — if you keep entries for several languages, set it the same way in each.',
                )}
              </p>
              <div className="stack">
                {RAIL_KEYS.map((k) => (
                  <div key={k} className="card flat stack" style={{ padding: 'var(--sp-4)' }}>
                    <Checkbox label={L(RAIL_LABEL[k][0], RAIL_LABEL[k][1])} checked={cfg.rails[k].show} onChange={(e) => setRail(k, { show: e.target.checked })} />
                    <div className="form-grid cols-2">
                      <Input label={L('제목', 'Title')} value={cfg.rails[k].title} placeholder={lang === 'ko' ? RAIL_LABEL[k][0] : RAIL_LABEL[k][1]} disabled={!cfg.rails[k].show} onChange={(e) => setRail(k, { title: e.target.value })} />
                      <Input label={L('부제', 'Subtitle')} value={cfg.rails[k].subtitle} disabled={!cfg.rails[k].show} onChange={(e) => setRail(k, { subtitle: e.target.value })} />
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title={L('브랜드 블록', 'Brand blocks')}>
              <Repeater
                rows={cfg.blocks}
                onChange={(blocks) => set({ blocks })}
                blank={() => ({ key: '', title: '', body: '', cta: '', href: '/', image: '' })}
                addLabel={L('블록 추가', 'Add block')}
                emptyHint={L('비워 두면 기본 블록 3개(한달살기 맞교환 · 전세기 공유 · Local Life)가 표시됩니다.', 'Leave empty for the three default blocks (home exchange, charter sharing, Local Life).')}
                row={(v, patch, i) => (
                  <>
                    <Input label={L('제목', 'Title')} value={v.title} onChange={(e) => patch({ title: e.target.value })} />
                    <Input label={L('버튼 문구', 'Button label')} value={v.cta} onChange={(e) => patch({ cta: e.target.value })} />
                    <Input label={L('버튼 링크', 'Button link')} value={v.href} placeholder="/exchange" onChange={(e) => patch({ href: e.target.value })} />
                    <Input label={L('이미지 주소 (선택)', 'Image URL (optional)')} value={v.image} onChange={(e) => patch({ image: e.target.value })} />
                    <Input label={L('식별자 (선택)', 'Key (optional)')} value={v.key} placeholder={`block-${i + 1}`} onChange={(e) => patch({ key: e.target.value })} />
                    <Textarea label={L('본문', 'Body')} rows={3} value={v.body} onChange={(e) => patch({ body: e.target.value })} />
                  </>
                )}
              />
            </Section>

            <Section title={L('안심 약속', 'Safety promise')}>
              <Repeater
                rows={cfg.trust}
                onChange={(trust) => set({ trust })}
                blank={() => ({ icon: '' as const, title: '', body: '' })}
                addLabel={L('항목 추가', 'Add item')}
                emptyHint={L('비워 두면 기본 항목 4개(검증 숙소 · 안전 결제 · 동시 확정 맞교환 · 분쟁 지원)가 표시됩니다.', 'Leave empty for the four default items (verified stays, secure payments, paired exchange, dispute support).')}
                row={(v, patch) => (
                  <>
                    <Input label={L('제목', 'Title')} value={v.title} onChange={(e) => patch({ title: e.target.value })} />
                    <Input label={L('아이콘 이름', 'Icon name')} value={v.icon} placeholder="shield" hint={L('예: shield, lock, swap, support', 'e.g. shield, lock, swap, support')} onChange={(e) => patch({ icon: e.target.value as typeof v.icon })} />
                    <Textarea label={L('설명', 'Body')} rows={2} value={v.body} onChange={(e) => patch({ body: e.target.value })} />
                  </>
                )}
              />
            </Section>

            <Section>
              <div className="row">
                <Button variant="primary" icon="check" loading={busy === 'save'} onClick={save}>
                  {L('저장', 'Save')}
                </Button>
                <Button variant="ghost" icon="refresh" onClick={seed}>
                  {L('되돌리기', 'Discard changes')}
                </Button>
              </div>
              <ErrorText error={err} />
            </Section>
          </>
        )}
      </StateView>
    </>
  );
}
