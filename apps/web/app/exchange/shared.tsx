'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { f, item, str, num } from '@/lib/shape';
import { formatRange, parseDateRange } from '@/lib/format';
import { Steps, StatusBadge } from '@/components/ui';

export const EXCHANGE_STEPS = ['PROPOSE', 'AGREE_TERMS', 'VERIFY', 'SIGN', 'CONFIRMED', 'COMPLETED'] as const;

export function exchangeStep(status: string): number {
  const s = (status || '').toUpperCase();
  if (['PROPOSED', 'COUNTERED', 'REQUESTED', 'DRAFT'].includes(s)) return 0;
  if (['ACCEPTED'].includes(s)) return 2;
  if (['VERIFYING', 'VERIFICATION_PENDING', 'PENDING_VERIFICATION'].includes(s)) return 2;
  if (['VERIFIED', 'AGREEMENT_PENDING', 'SIGNING', 'PARTIALLY_SIGNED', 'SIGNED'].includes(s)) return 3;
  if (['CONFIRMED', 'IN_PROGRESS', 'ACTIVE'].includes(s)) return 4;
  if (['COMPLETED', 'CLOSED'].includes(s)) return 5;
  return 0;
}

export function exchangeView(d: any) {
  const x = item(d) ?? {};
  const terms = f<any>(x, 'terms', 'currentTerms', 'proposal') ?? x;
  const rng = (k: string) => parseDateRange(f(terms, k));
  const a = rng('requesterRange') ?? { start: str(terms, 'requesterStart', 'requesterCheckIn', 'startDate', 'start'), end: str(terms, 'requesterEnd', 'requesterCheckOut', 'endDate', 'end') };
  const b = rng('counterpartRange') ?? { start: str(terms, 'counterpartStart', 'counterpartCheckIn', 'startDate', 'start'), end: str(terms, 'counterpartEnd', 'counterpartCheckOut', 'endDate', 'end') };
  return {
    id: str(x, 'id'),
    status: str(x, 'status', 'state').toUpperCase(),
    version: num(x, 'version', 'termsVersion') ?? 1,
    requesterId: str(x, 'requesterId', 'proposerId', 'initiatorId'),
    counterpartId: str(x, 'counterpartId', 'recipientId', 'responderId'),
    requesterProperty: f<any>(x, 'requesterProperty') ?? { id: str(terms, 'requesterPropertyId', 'requesterHomeId'), title: str(x, 'requesterPropertyTitle') },
    counterpartProperty: f<any>(x, 'counterpartProperty') ?? { id: str(terms, 'counterpartPropertyId', 'counterpartHomeId'), title: str(x, 'counterpartPropertyTitle') },
    a,
    b,
    guests: num(terms, 'guests', 'guestCount'),
    note: str(terms, 'note', 'message'),
    lastActorId: str(x, 'lastActorId', 'lastProposedBy', 'updatedBy'),
    conversationId: str(x, 'conversationId'),
    raw: x,
  };
}
export type ExchangeView = ReturnType<typeof exchangeView>;

export function ExchangeHeader({ x }: { x: ExchangeView }) {
  const { L, lang } = useI18n();
  const labels = [L('제안', 'Propose'), L('조건 합의', 'Agree'), L('검증', 'Verify'), L('계약 서명', 'Sign'), L('확정', 'Confirmed'), L('완료', 'Completed')];
  return (
    <header className="stack" style={{ marginBottom: 16 }}>
      <Link href={`/exchange/${x.id}`} className="small">
        ← {L('맞교환 상세', 'Exchange')}
      </Link>
      <div className="row between">
        <h1 style={{ margin: 0 }}>
          {L('홈 맞교환', 'Home exchange')} <span className="mono small">#{x.id.slice(0, 8)}</span>
        </h1>
        <div className="row">
          <StatusBadge status={x.status} />
          <span className="badge">v{x.version}</span>
        </div>
      </div>
      <Steps steps={labels} current={exchangeStep(x.status)} />
      <p className="muted small" style={{ margin: 0 }}>
        {x.a.start && x.a.end ? `${L('내 방문', 'Stay A')}: ${formatRange(x.a.start, x.a.end, lang)}` : ''} {x.b.start && x.b.end ? ` · ${L('상대 방문', 'Stay B')}: ${formatRange(x.b.start, x.b.end, lang)}` : ''}
      </p>
    </header>
  );
}
