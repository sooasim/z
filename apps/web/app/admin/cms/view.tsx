'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api, post } from '@/lib/api';
import { str } from '@/lib/shape';
import { ResourceTable } from '@/components/table';
import { FormCard } from '@/components/form';
import { Modal, PageHeader, Section, Tabs, Button } from '@/components/ui';

type Tab = 'DESTINATION' | 'STORY' | 'FAQ' | 'PROMOTION' | 'PAGE' | 'LEGACY_CONTENT' | 'redirects';

export default function AdminCmsView() {
  const { L } = useI18n();
  const [tab, setTab] = useState<Tab>('DESTINATION');
  const [open, setOpen] = useState(false);
  const [k, setK] = useState(0);
  const isRedirect = tab === 'redirects';
  return (
    <>
      <PageHeader title={L('콘텐츠 · SEO', 'Content & SEO')} subtitle={L('여행지, 스토리, FAQ, 프로모션, 브랜드 블록과 레거시(WONT/식스샵) URL 리다이렉트를 관리합니다.', 'Destinations, stories, FAQ, promotions, brand blocks and legacy (WONT/Sixshop) redirects.')} actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>{isRedirect ? L('리다이렉트 추가', 'Add redirect') : L('새 콘텐츠', 'New content')}</Button>} />
      <Tabs label="CMS" value={tab} onChange={(v) => { setTab(v); setK(k + 1); }} tabs={[{ value: 'DESTINATION', label: L('여행지', 'Destinations') }, { value: 'STORY', label: L('스토리', 'Stories') }, { value: 'FAQ', label: 'FAQ' }, { value: 'PROMOTION', label: L('프로모션', 'Promotions') }, { value: 'PAGE', label: L('페이지·브랜드', 'Pages & brand') }, { value: 'LEGACY_CONTENT', label: L('레거시 콘텐츠', 'Legacy content') }, { value: 'redirects', label: L('리다이렉트', 'Redirects') }]} />
      <Section>
        {isRedirect ? (
          <ResourceTable
            key={k}
            path="/v1/admin/seo/redirects"
            columns={[
              { key: 'legacyPath|legacy_path', label: L('이전 경로', 'Legacy path') },
              { key: 'targetPath|target_path', label: L('새 경로', 'Target') },
              { key: 'statusCode|status_code', label: 'HTTP' },
              { key: 'approved', label: L('승인', 'Approved'), render: (r) => (r.approved ? <span className="pill ok">ON</span> : <span className="pill warn">{L('대기', 'Pending')}</span>) },
              { key: 'hits|hitCount', label: L('조회', 'Hits') },
              { key: 'source', label: L('출처', 'Source') },
            ]}
            actions={[
              { label: L('승인', 'Approve'), tone: 'primary', when: (r) => !r.approved, run: (r) => post('/v1/admin/seo/redirects/approve', { paths: [str(r, 'legacyPath', 'legacy_path')], approved: true }) },
              { label: L('비활성', 'Disable'), tone: 'danger', when: (r) => !!r.approved, run: (r) => post('/v1/admin/seo/redirects/approve', { paths: [str(r, 'legacyPath', 'legacy_path')], approved: false }) },
            ]}
          />
        ) : (
          <ResourceTable
            key={k}
            path="/v1/admin/cms/entries"
            query={{ type: tab }}
            columns={[
              { key: 'title', label: L('제목', 'Title') },
              { key: 'slug', label: 'Slug' },
              { key: 'locale', label: L('언어', 'Locale') },
              { key: 'status', label: L('상태', 'Status'), kind: 'status' },
              { key: 'publishedAt|updatedAt', label: L('게시/수정', 'Published'), kind: 'datetime' },
            ]}
            actions={[
              { label: L('게시', 'Publish'), tone: 'primary', when: (r) => str(r, 'status').toUpperCase() === 'DRAFT', run: (r) => post(`/v1/admin/cms/entries/${str(r, 'id')}/publish`, {}) },
              { label: L('내리기', 'Unpublish'), when: (r) => str(r, 'status').toUpperCase() === 'PUBLISHED', run: (r) => post(`/v1/admin/cms/entries/${str(r, 'id')}/unpublish`, {}) },
              { label: L('보관', 'Archive'), tone: 'danger', when: (r) => str(r, 'status').toUpperCase() !== 'ARCHIVED', reason: L('보관 사유', 'Reason'), run: (r, reason) => post(`/v1/admin/cms/entries/${str(r, 'id')}/archive`, { reason }) },
            ]}
          />
        )}
      </Section>
      <Modal open={open} onClose={() => setOpen(false)} title={isRedirect ? L('리다이렉트 추가', 'Add redirect') : L('새 콘텐츠', 'New content')} wide>
        {isRedirect ? (
          <FormCard
            fields={[
              { name: 'legacyPath', label: L('이전 경로 (예: /product/123)', 'Legacy path'), required: true },
              { name: 'targetPath', label: L('새 경로 (예: /travel/abc)', 'Target path'), required: true },
              { name: 'statusCode', label: 'HTTP', type: 'select', options: [{ value: '301', label: '301 Permanent' }, { value: '308', label: '308 Permanent' }, { value: '302', label: '302 Temporary' }] },
            ]}
            submit={async (b) => { await api('/v1/admin/seo/redirects', { method: 'PUT', body: { ...b, statusCode: Number(b.statusCode ?? 301) } }); setOpen(false); setK(k + 1); }}
          />
        ) : (
          <FormCard
            cols={2}
            fields={[
              { name: 'title', label: L('제목', 'Title'), required: true },
              { name: 'slug', label: 'Slug', required: true },
              { name: 'locale', label: L('언어', 'Locale'), type: 'select', options: [{ value: 'ko-KR', label: '한국어' }, { value: 'en-US', label: 'English' }] },
              { name: 'summary', label: L('요약', 'Summary') },
              { name: 'seo.description', label: L('SEO 설명', 'SEO description') },
              { name: 'data', label: L('구조화 데이터 (JSON, 예: 브랜드 블록)', 'Structured data (JSON)'), type: 'json', placeholder: '{"blocks": []}' },
              { name: 'bodyMd', label: L('본문 (마크다운)', 'Body (markdown)'), type: 'textarea' },
            ]}
            submit={async (b) => { await post('/v1/admin/cms/entries', { ...b, type: tab }); setOpen(false); setK(k + 1); }}
          />
        )}
      </Modal>
    </>
  );
}
