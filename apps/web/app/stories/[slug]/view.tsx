'use client';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { item, str } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { StateView } from '@/components/states';
import { DateText, PageHeader } from '@/components/ui';

/** CMS content is rendered as plain text paragraphs (no raw HTML injection). */
export default function StoryView() {
  const { slug } = useParams<{ slug: string }>();
  const { L } = useI18n();
  const st = useApi<any>(`/v1/content/story/${encodeURIComponent(slug)}`);
  return (
    <StateView state={st} skeleton="detail">
      {(d) => {
        const s = item(d);
        const body = str(s, 'body', 'content', 'markdown', 'text');
        return (
          <article style={{ maxWidth: 760, margin: '0 auto' }}>
            <PageHeader title={str(s, 'title')} subtitle={<DateText value={str(s, 'publishedAt', 'createdAt')} />} back="/stories" />
            <img src={str(s, 'coverUrl') || postcardFor(str(s, 'title'), slug)} alt="" style={{ width: '100%', borderRadius: 'var(--r-xl)', aspectRatio: '16 / 9', objectFit: 'cover', marginBottom: 24 }} />
            {body.split(/\n{2,}/).map((para, i) => (
              <p key={i} style={{ fontSize: 'var(--fs-lg)', lineHeight: 1.8 }}>{para.replace(/^#+\s*/, '')}</p>
            ))}
            {!body && <p className="muted">{L('내용이 없습니다.', 'No content.')}</p>}
          </article>
        );
      }}
    </StateView>
  );
}
