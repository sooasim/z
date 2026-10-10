'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { f, item, items, num, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { ButtonLink, DateText, PageHeader, RatingStars, Section, StatusPill } from '@/components/ui';
import { useCachedApi } from '@/components/traveler/hooks';
import { REVIEW_TARGET_LABEL } from '@/components/traveler/labels';
import { pickPair } from '@/lib/phrases';

/** Name + link of what a review is about (stays, guides and tours resolve; hosts/partners show the role). */
function useTargetName(type: string, id: string) {
  const t = type.toUpperCase();
  const path = !id ? null : t === 'PROPERTY' ? `/v1/properties/${id}` : t === 'GUIDE' ? `/v1/guides/${id}` : t === 'TRAVEL_PRODUCT' ? `/v1/travel-products/${id}` : null;
  const { data } = useCachedApi<any>(path);
  const d = item(data) ?? {};
  if (t === 'PROPERTY') return { name: str(d, 'title'), href: str(d, 'slug') ? `/stay/${str(d, 'slug')}` : '' };
  if (t === 'GUIDE') return { name: str(d, 'displayName'), href: `/guides/${id}` };
  if (t === 'TRAVEL_PRODUCT') return { name: str(d, 'title'), href: `/travel/${id}` };
  return { name: '', href: '' };
}

function ReviewCard({ r, mine }: { r: any; mine: boolean }) {
  const { L, lang } = useI18n();
  const type = str(r, 'targetType', 'target_type');
  const target = useTargetName(type, str(r, 'targetId', 'target_id'));
  const label = pickPair((REVIEW_TARGET_LABEL[type.toUpperCase()] ?? [type, type]), lang);
  const resp = f<any>(r, 'response');
  return (
    <li className="card stack">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="xs muted">{mine ? label : str(r, 'authorName', 'author.displayName') || L('익명 회원', 'Member')}</div>
          <strong>{mine ? (target.href ? <Link href={target.href} style={{ color: 'inherit' }}>{target.name || label}</Link> : target.name || L(`${label} 후기`, `${label} review`)) : label}</strong>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <RatingStars value={num(r, 'rating')} />
          {str(r, 'status') && str(r, 'status').toUpperCase() !== 'PUBLISHED' && <StatusPill status={str(r, 'status')} />}
        </div>
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{str(r, 'body', 'comment')}</p>
      {resp && str(resp, 'body') && (
        <div className="card flat" style={{ background: 'var(--surface-2)', padding: 12 }}>
          <div className="xs muted" style={{ fontWeight: 700 }}>{L('호스트 답변', 'Response')}</div>
          <p className="small" style={{ margin: '4px 0 0' }}>{str(resp, 'body')}</p>
        </div>
      )}
      <span className="xs muted">
        <DateText value={str(r, 'createdAt')} />
      </span>
    </li>
  );
}

export default function AccountReviewsView() {
  const { L } = useI18n();
  const { user } = useAuth();
  const mine = useApi<any>(user ? '/v1/me/reviews' : null, { auth: true });
  const about = useApi<any>(user ? '/v1/reviews' : null, { auth: true, query: { targetType: 'HOST', targetId: user?.id } });
  const pending = Array.isArray(mine.data?.pending) ? mine.data.pending.length : 0;
  return (
    <RequireAuth>
      <PageHeader
        title={L('내 후기', 'My reviews')}
        subtitle={pending ? L(`후기를 기다리는 여행이 ${pending}건 있어요.`, `${pending} trip${pending > 1 ? 's' : ''} waiting for your review.`) : undefined}
        actions={<ButtonLink variant="primary" icon="star" href="/reviews">{L('후기 작성하기', 'Write a review')}</ButtonLink>}
      />
      <Section title={L('내가 쓴 후기', 'Written by me')}>
        <StateView
          state={mine}
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState illo="generic" title={L('아직 작성한 후기가 없어요', 'No reviews yet')} action={<ButtonLink variant="primary" href="/reviews">{L('후기 쓰러 가기', 'Write a review')}</ButtonLink>}>
              {L('여행을 마친 뒤 남긴 후기는 다른 여행자에게 큰 도움이 돼요.', 'Your reviews help other travelers choose well.')}
            </EmptyState>
          }
        >
          {(d) => (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {items(d).map((r: any) => (
                <ReviewCard key={str(r, 'id')} r={r} mine />
              ))}
            </ul>
          )}
        </StateView>
      </Section>
      <Section title={L('나에 대한 후기', 'About me')}>
        <StateView
          state={about}
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState illo="generic" title={L('아직 받은 후기가 없어요', 'No reviews about you yet')}>
              {L('호스트·가이드·맞교환 상대가 남긴 후기가 여기에 표시돼요.', 'Reviews from hosts, guides and exchange partners appear here.')}
            </EmptyState>
          }
        >
          {(d) => (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {items(d).map((r: any) => (
                <ReviewCard key={str(r, 'id')} r={r} mine={false} />
              ))}
            </ul>
          )}
        </StateView>
      </Section>
    </RequireAuth>
  );
}
