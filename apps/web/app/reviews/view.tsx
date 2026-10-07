'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Alert, ErrorText, PageHeader, Textarea } from '@/components/ui';

/** Write reviews for eligible completed transactions (one per target per policy window — enforced by API). */
export default function ReviewsView() {
  const { L } = useI18n();
  const sp = useSearchParams();
  const st = useApi<any>('/v1/reviews/eligible', { auth: true });
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [target, setTarget] = useState<{ type: string; id: string; subjectType: string; subjectId: string } | null>(
    sp.get('reservationId') || sp.get('subjectId')
      ? { type: sp.get('targetType') ?? 'PROPERTY', id: sp.get('targetId') ?? '', subjectType: sp.get('subjectType') ?? 'RESERVATION', subjectId: sp.get('subjectId') ?? sp.get('reservationId') ?? '' }
      : null,
  );
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  return (
    <RequireAuth>
      <PageHeader title={L('후기 작성', 'Write a review')} subtitle={L('완료된 숙박·맞교환·가이드·투어에 대해서만 후기를 남길 수 있어요.', 'Only completed stays, exchanges, guides or tours can be reviewed.')} />
      {done && <Alert tone="ok">{L('후기가 등록되었습니다. 상대방도 후기를 남기면 동시에 공개됩니다.', 'Review submitted. It is published when both sides review (or the window closes).')}</Alert>}
      {target ? (
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await post('/v1/reviews', { targetType: target.type, targetId: target.id || undefined, subjectType: target.subjectType, subjectId: target.subjectId, reservationId: target.subjectType === 'RESERVATION' ? target.subjectId : undefined, rating, body }, { idempotencyKey: `review-${target.subjectType}-${target.subjectId}` });
              setDone(true);
              setTarget(null);
              setBody('');
              st.reload();
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <fieldset>
            <legend>{L('평점', 'Rating')}</legend>
            <div className="chip-group" role="radiogroup">
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="chip" style={{ display: 'inline-flex', gap: 4 }}>
                  <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} />
                  {'★'.repeat(n)}
                </label>
              ))}
            </div>
          </fieldset>
          <Textarea label={L('후기 내용', 'Your review')} value={body} onChange={(e) => setBody(e.target.value)} required minLength={10} maxLength={2000} />
          <div className="row">
            <button className="btn primary">{L('등록', 'Submit')}</button>
            <button type="button" className="btn ghost" onClick={() => setTarget(null)}>{L('취소', 'Cancel')}</button>
          </div>
          <ErrorText error={err} />
        </form>
      ) : (
        <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState title={L('후기를 작성할 수 있는 여행이 없습니다.', 'Nothing to review right now.')} />}>
          {(d) => (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {items(d).map((r: any, i) => (
                <li key={i} className="card flat row between">
                  <div>
                    <strong>{str(r, 'title', 'targetTitle')}</strong>
                    <div className="small muted">{str(r, 'subjectType')} · {L('작성 기한', 'Due')} {str(r, 'deadline', 'windowEndsAt').slice(0, 10)}</div>
                  </div>
                  <button className="btn" onClick={() => setTarget({ type: str(r, 'targetType'), id: str(r, 'targetId'), subjectType: str(r, 'subjectType'), subjectId: str(r, 'subjectId') })}>
                    {L('후기 쓰기', 'Review')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </StateView>
      )}
    </RequireAuth>
  );
}
