'use client';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items, num, str } from '@/lib/shape';
import { Avatar, DateText, Icon, RatingStars, Section, Skeleton } from '@/components/ui';

/**
 * Reviews block for a listing / guide: "★ 4.8 · 후기 12개" heading; "아직 후기가 없어요" when there are none (never the
 * RatingStars "신규" placeholder in front of "후기").
 */
export function ReviewsSection({ targetType, targetId, rating, count, emptyHint }: { targetType: 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT'; targetId: string; rating?: number; count: number; emptyHint?: string }) {
  const { L } = useI18n();
  const st = useApi<any>(targetId ? '/v1/reviews' : null, { query: { targetType, targetId, limit: 6 } });
  const rows = items(st.data);
  const n = Math.max(count, rows.length);
  const title =
    n > 0 && rating !== undefined ? (
      <span className="row" style={{ gap: 10 }}>
        <Icon name="star" size={22} filled style={{ color: 'var(--accent-deco)' }} />
        <span>
          {rating.toFixed(2)} · {L(`후기 ${n}개`, `${n} review${n === 1 ? '' : 's'}`)}
        </span>
      </span>
    ) : (
      L('후기', 'Reviews')
    );
  return (
    <Section title={title}>
      {st.loading ? (
        <div className="grid-2 even">
          <Skeleton h={110} />
          <Skeleton h={110} />
        </div>
      ) : st.error || rows.length === 0 ? (
        <div className="card flat row nowrap" style={{ background: 'var(--surface-2)', gap: 14 }}>
          <span aria-hidden="true" style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--surface)', color: 'var(--text-muted)', flex: '0 0 auto' }}>
            <Icon name="star" size={20} />
          </span>
          <div>
            <strong>{L('아직 후기가 없어요', 'No reviews yet')}</strong>
            <p className="small muted" style={{ margin: '2px 0 0' }}>{emptyHint ?? L('후기는 실제로 이용을 마친 회원만 남길 수 있어요.', 'Only members who completed a booking can leave a review.')}</p>
          </div>
        </div>
      ) : (
        <div className="grid-2 even">
          {rows.map((r: any, i) => {
            const name = str(r, 'authorName', 'author.displayName', 'reviewerName') || L('게스트', 'Guest');
            const reply = str(r, 'response.body', 'hostResponse', 'reply');
            return (
              <article key={r.id ?? i} className="stack">
                <div className="row nowrap">
                  <Avatar name={name} size={44} decorative />
                  <div className="grow">
                    <strong>{name}</strong>
                    <div className="xs muted">
                      <DateText value={str(r, 'createdAt', 'publishedAt')} />
                    </div>
                  </div>
                  <RatingStars value={num(r, 'rating', 'overallRating')} compact />
                </div>
                <p style={{ margin: 0 }}>{str(r, 'body', 'comment', 'text')}</p>
                {reply && (
                  <p className="small muted" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10, margin: 0 }}>
                    <strong>{L('답변', 'Response')}</strong> · {reply}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
