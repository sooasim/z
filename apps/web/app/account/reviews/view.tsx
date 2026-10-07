'use client';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { PageHeader, Section } from '@/components/ui';
import Link from 'next/link';

export default function AccountReviewsView() {
  const { L } = useI18n();
  const { user } = useAuth();
  return (
    <RequireAuth>
      <PageHeader title={L('내 후기', 'My reviews')} actions={<Link className="btn primary" href="/reviews">{L('후기 작성하기', 'Write a review')}</Link>} />
      <Section title={L('내가 쓴 후기', 'Written by me')}>
        <ResourceTable
          path={user ? '/v1/me/reviews' : null}
          columns={[
            { key: 'targetType', label: L('대상', 'Target') },
            { key: 'rating', label: L('평점', 'Rating') },
            { key: 'body|comment', label: L('내용', 'Text') },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
            { key: 'createdAt', label: L('작성일', 'Date'), kind: 'date' },
          ]}
          empty={<p className="muted">{L('아직 작성한 후기가 없습니다.', 'No reviews yet.')}</p>}
        />
      </Section>
      <Section title={L('나에 대한 후기', 'About me')}>
        <ResourceTable
          path={user ? '/v1/reviews' : null}
          query={{ targetType: 'HOST', targetId: user?.id }}
          columns={[
            { key: 'authorName|author.displayName', label: L('작성자', 'Author') },
            { key: 'rating', label: L('평점', 'Rating') },
            { key: 'body|comment', label: L('내용', 'Text') },
            { key: 'createdAt', label: L('작성일', 'Date'), kind: 'date' },
          ]}
          empty={<p className="muted">{L('받은 후기가 없습니다.', 'No reviews received.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}
