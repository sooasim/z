'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { arr, f, item, str, num } from '@/lib/shape';
import { formatRange, parseDateRange } from '@/lib/format';
import { postcardFor } from '@/lib/art';
import { StatusPill, Stepper } from '@/components/ui';

/** Proposal → Accepted → Verification → Agreement → Confirmed (Completed = all done). */
export function exchangeStep(status: string): number {
  const s = (status || '').toUpperCase();
  if (['REQUESTED', 'COUNTERED', 'PROPOSED', 'DRAFT'].includes(s)) return 0;
  if (['MUTUAL_ACCEPTED', 'ACCEPTED'].includes(s)) return 1;
  if (['VERIFICATION_PENDING', 'VERIFYING'].includes(s)) return 2;
  if (['AGREEMENT_PENDING', 'SIGNED'].includes(s)) return 3;
  // CONFIRMED and later: every step of the 5-step progress bar is complete.
  if (['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(s)) return 5;
  return 0;
}

const range = (v: any) => parseDateRange(v) ?? { start: str(v, 'start'), end: str(v, 'end') };

/**
 * View-model over GET /v1/exchanges/:id. Party A = requester (home A), party B = responder (home B).
 * `datesA` = when home A is occupied (B stays at A); `datesB` = when home B is occupied (A stays at B).
 */
export function exchangeView(d: any, me?: string) {
  const x = item(d) ?? {};
  const offer = f<any>(x, 'currentOffer') ?? {};
  const requesterId = str(x, 'requesterId', 'requester.id');
  const responderId = str(x, 'responderId', 'responder.id', 'counterpartId');
  const role = str(x, 'role') || (me && me === requesterId ? 'REQUESTER' : me && me === responderId ? 'RESPONDER' : '');
  return {
    id: str(x, 'id'),
    status: str(x, 'status', 'state').toUpperCase(),
    version: num(x, 'currentOfferVersion', 'version') ?? num(offer, 'version') ?? 1,
    nextAction: str(x, 'nextAction'),
    role,
    requesterId,
    responderId,
    requesterName: str(x, 'requester.displayName', 'requesterName'),
    responderName: str(x, 'responder.displayName', 'counterpartName'),
    propertyA: f<any>(x, 'propertyA', 'requesterProperty') ?? {},
    propertyB: f<any>(x, 'propertyB', 'counterpartProperty') ?? {},
    datesA: range(f(x, 'datesA') ?? f(offer, 'datesA')),
    datesB: range(f(x, 'datesB') ?? f(offer, 'datesB')),
    guestsA: num(offer, 'guestsA'),
    guestsB: num(offer, 'guestsB'),
    message: str(offer, 'message'),
    lastOfferBy: str(x, 'lastOfferBy', 'lastActorId'),
    conversationId: str(x, 'conversationId'),
    offers: arr<any>(x, 'offers'),
    verifications: arr<any>(x, 'verifications'),
    agreement: f<any>(x, 'agreement'),
    addresses: f<any>(x, 'addresses'),
    raw: x,
  };
}
export type ExchangeView = ReturnType<typeof exchangeView>;

function HomeTile({ home, who, range, label }: { home: any; who: string; range: { start: string; end: string }; label: string }) {
  const { lang } = useI18n();
  const title = str(home, 'title', 'name') || `#${str(home, 'id').slice(0, 8)}`;
  const city = str(home, 'city', 'address.city');
  const cover = str(home, 'coverUrl', 'coverImageUrl') || postcardFor(city || title, str(home, 'id'));
  return (
    <div className="home">
      <div className="art"><img src={cover} alt="" /></div>
      <div style={{ minWidth: 0 }}>
        <span className="xs muted">{who}</span>
        <strong>{title}</strong>
        <span className="small muted">{city}</span>
        {range.start && range.end && <div className="xs" style={{ marginTop: 4 }}>{label}: {formatRange(range.start, range.end, lang)}</div>}
      </div>
    </div>
  );
}

/** Visual two-home "swap" header + progress stepper used on every exchange page. */
export function ExchangeHeader({ x }: { x: ExchangeView }) {
  const { L } = useI18n();
  const { user } = useAuth();
  const labels = [L('제안', 'Proposal'), L('수락', 'Accepted'), L('검증', 'Verification'), L('계약', 'Agreement'), L('확정', 'Confirmed')];
  const meReq = x.role === 'REQUESTER' || user?.id === x.requesterId;
  return (
    <header style={{ marginBottom: 'var(--sp-6)' }}>
      <Link href={`/exchange/${x.id}`} className="btn ghost sm" style={{ marginLeft: -10 }}>
        ← {L('맞교환 상세', 'Exchange overview')}
      </Link>
      <div className="row between" style={{ margin: '8px 0 16px' }}>
        <h1 style={{ margin: 0 }}>
          {L('홈 맞교환', 'Home exchange')} <span className="mono small muted">#{x.id.slice(0, 8)}</span>
        </h1>
        <div className="row" style={{ gap: 8 }}>
          <StatusPill status={x.status} />
          <span className="badge" title={L('조건 버전', 'Terms version')}>v{x.version}</span>
        </div>
      </div>
      <div className="swap" aria-label={L('맞교환하는 두 집', 'The two homes being exchanged')}>
        <HomeTile home={x.propertyA} who={meReq ? L('내 집 (A)', 'My home (A)') : `${x.requesterName || L('요청자', 'Requester')} (A)`} range={x.datesA} label={L('이 집이 사용되는 기간', 'Occupied')} />
        <div className="icon" aria-hidden="true">⇄</div>
        <HomeTile home={x.propertyB} who={!meReq && user ? L('내 집 (B)', 'My home (B)') : `${x.responderName || L('상대', 'Host')} (B)`} range={x.datesB} label={L('이 집이 사용되는 기간', 'Occupied')} />
      </div>
      <Stepper steps={labels} current={exchangeStep(x.status)} label={L('맞교환 진행 단계', 'Exchange progress')} />
    </header>
  );
}
