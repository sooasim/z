'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, item, str } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Alert, Button, ButtonLink, ErrorText, Icon, PageHeader, Section } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { styles as s } from '@/components/traveler/ui';
import { useCachedApi } from '@/components/traveler/hooks';
import { REVIEW_TARGET_LABEL, dayLabel, subjectLabel } from '@/components/traveler/labels';

interface Target {
  type: string;
  id: string;
  subjectType: string;
  subjectId: string;
}

/** Title + dates of the transaction being reviewed (reservation / order / guide booking). */
function useSubject(t: Target | null) {
  const { L, lang } = useI18n();
  const type = (t?.subjectType ?? '').toUpperCase();
  const path = !t?.subjectId ? null : type === 'RESERVATION' ? `/v1/reservations/${t.subjectId}` : type === 'ORDER' ? `/v1/orders/${t.subjectId}` : type === 'GUIDE_BOOKING' ? `/v1/guide-bookings/${t.subjectId}` : null;
  const { data } = useCachedApi<any>(path);
  const d = item(data) ?? {};
  if (type === 'RESERVATION') return { title: str(d, 'property.title') || L('숙소 예약', 'Stay'), meta: str(d, 'checkIn') ? formatRange(str(d, 'checkIn'), str(d, 'checkOut'), lang, { nights: true }) : '', propertyId: str(d, 'propertyId'), hostId: str(d, 'hostId') };
  if (type === 'ORDER') return { title: str(Array.isArray(d.items) ? d.items[0] : null, 'title') || L('여행 상품', 'Tour'), meta: str(d, 'code'), propertyId: '', hostId: '' };
  if (type === 'GUIDE_BOOKING') return { title: L('가이드 일정', 'Guide session'), meta: '', propertyId: '', hostId: '' };
  return { title: subjectLabel(type, lang), meta: '', propertyId: '', hostId: '' };
}

function StarInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { L } = useI18n();
  const words = [L('별로예요', 'Poor'), L('아쉬워요', 'Fair'), L('보통이에요', 'Okay'), L('좋았어요', 'Good'), L('최고예요', 'Excellent')];
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label" style={{ marginBottom: 6 }}>
        {L('평점', 'Rating')} <span aria-hidden="true">*</span>
      </legend>
      <div className="row" style={{ gap: 4 }} role="radiogroup" aria-label={L('평점', 'Rating')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} style={{ cursor: 'pointer', color: n <= value ? 'var(--accent)' : 'var(--border-strong)', lineHeight: 0 }}>
            <input type="radio" name="rating" value={n} checked={value === n} onChange={() => onChange(n)} className="sr-only" />
            <Icon name="star" size={32} filled={n <= value} />
            <span className="sr-only">{`${n} / 5 · ${words[n - 1]}`}</span>
          </label>
        ))}
        <span className="small" style={{ marginLeft: 8, fontWeight: 700 }} aria-hidden="true">
          {words[value - 1]}
        </span>
      </div>
    </fieldset>
  );
}

function ReviewForm({ target, onDone, onCancel }: { target: Target; onDone: () => void; onCancel: () => void }) {
  const { L, lang } = useI18n();
  const toast = useToast();
  const subj = useSubject(target);
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const targetType = target.type || 'PROPERTY';
  const targetId = target.id || (targetType === 'PROPERTY' ? subj.propertyId : targetType === 'HOST' ? subj.hostId : '');
  const len = body.trim().length;
  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (len < 10) return;
        setBusy(true);
        setErr(null);
        try {
          await post('/v1/reviews', { transactionType: target.subjectType, transactionId: target.subjectId, targetType, targetId: targetId || undefined, rating, body: body.trim() });
          toast.show(L('후기를 등록했어요. 감사합니다!', 'Thanks for your review!'));
          onDone();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <div className="xs muted">{(REVIEW_TARGET_LABEL[targetType.toUpperCase()] ?? [targetType, targetType])[lang === 'ko' ? 0 : 1]} {L('후기', 'review')}</div>
        <h2 style={{ margin: '2px 0 0', fontSize: 'var(--fs-xl)' }}>{subj.title}</h2>
        {subj.meta && <div className="small muted">{subj.meta}</div>}
      </div>
      <StarInput value={rating} onChange={setRating} />
      <label className="field" htmlFor="review-body">
        <span>
          {L('어떤 점이 좋았나요?', 'How was it?')} <span aria-hidden="true">*</span>
        </span>
        <textarea
          id="review-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          minLength={10}
          maxLength={2000}
          rows={6}
          aria-describedby="review-hint"
          placeholder={L('위치, 청결, 소통 등 다음 여행자에게 도움이 될 이야기를 남겨 주세요.', 'Location, cleanliness, communication… what should the next traveler know?')}
        />
        <span className="row between" id="review-hint">
          <small className="hint">{L('10자 이상 · 상대방도 후기를 쓰거나 작성 기간이 끝나면 함께 공개돼요.', 'At least 10 characters · published when both sides review or the window closes.')}</small>
          <small className={`${s.counter} ${len > 0 && len < 10 ? s.over : ''}`}>{len}/2000</small>
        </span>
      </label>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={len < 10}>
          {L('후기 등록', 'Submit review')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {L('취소', 'Cancel')}
        </Button>
      </div>
      <ErrorText error={err} />
    </form>
  );
}

function PendingRow({ p, onPick }: { p: any; onPick: (t: Target) => void }) {
  const { L, lang } = useI18n();
  const t: Target = { type: str(p, 'targetType', 'target_type'), id: str(p, 'targetId', 'target_id'), subjectType: str(p, 'transactionType', 'transaction_type'), subjectId: str(p, 'transactionId', 'transaction_id') };
  const subj = useSubject(t);
  const due = str(p, 'deadline', 'windowEndsAt');
  return (
    <li className="card flat row between" style={{ gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <strong>{subj.title}</strong>
        <div className="small muted">
          {[subj.meta, `${(REVIEW_TARGET_LABEL[t.type.toUpperCase()] ?? [t.type, t.type])[lang === 'ko' ? 0 : 1]} ${L('평가', 'review')}`, due && L(`${dayLabel(due, lang)}까지 작성`, `due ${dayLabel(due, lang)}`)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Button variant="primary" size="sm" icon="star" onClick={() => onPick(t)}>
        {L('후기 쓰기', 'Write review')}
      </Button>
    </li>
  );
}

/** Write reviews for eligible completed transactions (one per target per policy window — enforced by API). */
export default function ReviewsView() {
  const { L } = useI18n();
  const sp = useSearchParams();
  const st = useApi<any>('/v1/me/reviews', { auth: true });
  const pending = (d: any) => (Array.isArray(d?.pending) ? d.pending : items(d));
  const initial: Target | null =
    sp.get('reservationId') || sp.get('subjectId')
      ? { type: (sp.get('targetType') ?? 'PROPERTY').replace('USER', 'EXCHANGE_PARTNER'), id: sp.get('targetId') ?? '', subjectType: sp.get('subjectType') ?? 'RESERVATION', subjectId: sp.get('subjectId') ?? sp.get('reservationId') ?? '' }
      : null;
  const [target, setTarget] = useState<Target | null>(initial);
  const [done, setDone] = useState(false);
  return (
    <RequireAuth>
      <PageHeader
        title={L('후기 작성', 'Write a review')}
        subtitle={L('완료된 숙박·맞교환·가이드·투어에 대해 후기를 남길 수 있어요.', 'Review completed stays, exchanges, guides and tours.')}
        actions={<ButtonLink size="sm" href="/account/reviews">{L('내가 쓴 후기', 'My reviews')}</ButtonLink>}
      />
      <div className="stack-lg">
        {done && <Alert tone="ok">{L('후기가 등록되었어요. 상대방도 후기를 남기면 동시에 공개돼요.', 'Review submitted. It’s published when both sides have reviewed (or the window closes).')}</Alert>}
        {target && (
          <ReviewForm
            target={target}
            onCancel={() => setTarget(null)}
            onDone={() => {
              setDone(true);
              setTarget(null);
              st.reload();
            }}
          />
        )}
        <Section title={L('후기를 기다리는 여행', 'Waiting for your review')}>
          <StateView
            state={st}
            isEmpty={(d) => pending(d).length === 0}
            empty={
              <EmptyState illo="trips" title={L('지금 후기를 쓸 여행이 없어요', 'Nothing to review right now')} action={<ButtonLink variant="primary" href="/trips">{L('내 여행 보기', 'View my trips')}</ButtonLink>}>
                {L('여행을 마치면 여기에서 후기를 남길 수 있어요.', 'After a trip ends you can review it here.')}
              </EmptyState>
            }
          >
            {(d) => (
              <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {pending(d).map((p: any, i: number) => (
                  <PendingRow key={i} p={p} onPick={(t) => { setTarget(t); setDone(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
                ))}
              </ul>
            )}
          </StateView>
          <p className="xs muted" style={{ margin: 0 }}>
            {L('후기는 실제 이용이 확인된 예약에만 작성할 수 있어요. ', 'Only verified bookings can be reviewed. ')}
            <Link href="/support">{L('후기 정책 보기', 'Review policy')}</Link>
          </p>
        </Section>
      </div>
    </RequireAuth>
  );
}
