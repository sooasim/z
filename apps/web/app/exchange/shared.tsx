'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { arr, f, item, str, num } from '@/lib/shape';
import { formatRange, parseDateRange } from '@/lib/format';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { Icon, StatusPill, Stepper } from '@/components/ui';

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

/** Next-action copy for `nextAction` (also used by the trips list). */
export const NEXT_ACTION: Record<string, [string, string]> = {
  RESPOND: ['상대의 제안에 응답할 차례예요.', 'It’s your turn to respond.'],
  AWAIT_RESPONSE: ['상대방의 응답을 기다리는 중이에요.', 'Waiting for the other member.'],
  SAFETY_ACK: ['안전 수칙 확인이 필요해요.', 'Please acknowledge the safety guidelines.'],
  AWAIT_VERIFICATION: ['양측 검증을 진행 중이에요.', 'Verification in progress.'],
  SIGN_AGREEMENT: ['계약서에 서명해 주세요.', 'Please sign the agreement.'],
  AWAIT_COUNTERPARTY_SIGNATURE: ['상대방의 서명을 기다리고 있어요.', 'Waiting for the other signature.'],
  CONFIRM: ['양측 서명 완료! 맞교환을 확정하세요.', 'Both signed — confirm the exchange.'],
  PREPARE_TRIP: ['확정되었어요. 여행을 준비하세요!', 'Confirmed — get ready!'],
  COMPLETE_AFTER_STAY: ['머문 뒤 완료 처리해 주세요.', 'Mark complete after your stays.'],
  LEAVE_REVIEW: ['후기를 남겨 주세요.', 'Leave a review.'],
};

/** Exchange eligibility requirements (codes from GET /v1/exchange/eligibility `unmet`) with where to fix each. */
export const ELIGIBILITY: Record<string, { ko: string; en: string; href: string }> = {
  ACCOUNT_NOT_ACTIVE: { ko: '계정 활성화', en: 'Active account', href: '/account' },
  IDENTITY_NOT_VERIFIED: { ko: '본인 인증', en: 'Identity verified', href: '/verification' },
  NO_EXCHANGE_HOME: { ko: '맞교환 가능한 내 집 등록', en: 'A published home open to exchange', href: '/host/listings' },
  ACTIVE_SANCTION: { ko: '이용 제한 없음', en: 'No active restrictions', href: '/support' },
  PROFILE_INCOMPLETE: { ko: '맞교환 프로필 작성', en: 'Exchange profile complete', href: '/exchange/onboarding#profile' },
};

/** "1번째 제안" reads oddly — the first offer is "첫 제안". */
export function offerLabel(version: number, L: (ko: string, en: string) => string): string {
  if (version <= 1) return L('첫 제안', 'First offer');
  return L(`${version}번째 제안`, `Offer #${version}`);
}

const range = (v: any) => parseDateRange(v) ?? { start: str(v, 'start'), end: str(v, 'end') };

/**
 * View-model over GET /v1/exchanges/:id. Party A = requester (home A), party B = responder (home B).
 * `datesA` = when home A is occupied (B stays at A); `datesB` = when home B is occupied (A stays at B).
 * `guestsA` / `guestsB` = guests staying at home A / B.
 */
export function exchangeView(d: any, me?: string) {
  const x = item(d) ?? {};
  const offer = f<any>(x, 'currentOffer') ?? {};
  const requesterId = str(x, 'requesterId', 'requester.id');
  const responderId = str(x, 'responderId', 'responder.id', 'counterpartId');
  const role = str(x, 'role') || (me && me === requesterId ? 'REQUESTER' : me && me === responderId ? 'RESPONDER' : '');
  const v = {
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
    terms: (f<any>(offer, 'terms') ?? {}) as Record<string, unknown>,
    message: str(offer, 'message'),
    respondBy: str(x, 'respondBy'),
    lastOfferBy: str(x, 'lastOfferBy', 'lastActorId'),
    conversationId: str(x, 'conversationId'),
    offers: arr<any>(x, 'offers'),
    verifications: arr<any>(x, 'verifications'),
    agreement: f<any>(x, 'agreement'),
    addresses: f<any>(x, 'addresses'),
    raw: x,
  };
  const iAmA = role === 'REQUESTER';
  return {
    ...v,
    /** Perspective helpers: my home / their home, when I stay there / when they stay at mine. */
    myHome: iAmA ? v.propertyA : v.propertyB,
    theirHome: iAmA ? v.propertyB : v.propertyA,
    myStay: iAmA ? v.datesB : v.datesA,
    theirStay: iAmA ? v.datesA : v.datesB,
    myGuests: iAmA ? v.guestsB : v.guestsA,
    theirGuests: iAmA ? v.guestsA : v.guestsB,
    otherName: iAmA ? v.responderName : v.requesterName,
  };
}
export type ExchangeView = ReturnType<typeof exchangeView>;

export const homeTitle = (h: any, fallback: string) => str(h, 'title', 'name') || fallback;

function HomeTile({ home, who, range: r, label }: { home: any; who: string; range: { start: string; end: string }; label: string }) {
  const { lang, L } = useI18n();
  const title = homeTitle(home, L('집 정보 없음', 'Home'));
  const city = placeLabel(str(home, 'city', 'address.city'), lang);
  const cover = str(home, 'coverUrl', 'coverImageUrl') || postcardFor(str(home, 'city') || title, str(home, 'id'));
  return (
    <div className="home">
      <div className="art">
        <img src={cover} alt="" />
      </div>
      <div style={{ minWidth: 0 }}>
        <span className="xs muted">{who}</span>
        <strong>{title}</strong>
        <span className="small muted">{city}</span>
        {r.start && r.end && (
          <div className="xs" style={{ marginTop: 4 }}>
            {label}: {formatRange(r.start, r.end, lang, { nights: true })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Visual two-home "swap" header + progress stepper used on every exchange page. Titled by the homes, never the id. */
export function ExchangeHeader({ x, back = true }: { x: ExchangeView; back?: boolean }) {
  const { L } = useI18n();
  const { user } = useAuth();
  const labels = [L('제안', 'Proposal'), L('수락', 'Accepted'), L('검증', 'Verification'), L('계약', 'Agreement'), L('확정', 'Confirmed')];
  const known = x.role === 'REQUESTER' || x.role === 'RESPONDER' || !!user;
  const mine = homeTitle(x.myHome, L('내 집', 'My home'));
  const theirs = homeTitle(x.theirHome, L('상대 집', 'Their home'));
  const negotiating = ['REQUESTED', 'COUNTERED'].includes(x.status);
  return (
    <header style={{ marginBottom: 'var(--sp-6)' }}>
      {back && (
        <Link href={`/exchange/${x.id}`} className="btn ghost sm" style={{ marginLeft: -10 }}>
          <Icon name="left" size={16} /> {L('맞교환 상세', 'Exchange overview')}
        </Link>
      )}
      <div className="row between" style={{ margin: '8px 0 16px', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow" style={{ margin: '0 0 4px' }}>{L('홈 맞교환', 'Home exchange')}</p>
          <h1 style={{ margin: 0, fontSize: 'clamp(var(--fs-xl), 1rem + 1.4vw, var(--fs-3xl))' }}>
            {mine} <span aria-label={L('와(과) 맞교환', 'swapped with')} style={{ color: 'var(--accent-deco)' }}>⇄</span> {theirs}
          </h1>
          {x.otherName && <p className="small muted" style={{ margin: '4px 0 0' }}>{L(`${x.otherName} 님과의 맞교환`, `With ${x.otherName}`)}</p>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <StatusPill status={x.status} />
          {negotiating && <span className="badge">{offerLabel(x.version, L)}</span>}
        </div>
      </div>
      <div className="swap" aria-label={L('맞교환하는 두 집', 'The two homes being exchanged')}>
        <HomeTile home={x.myHome} who={known ? L('내 집', 'My home') : L('요청자 집', 'Requester’s home')} range={x.theirStay} label={L('상대가 머무는 기간', 'They stay')} />
        <div className="icon" aria-hidden="true">
          <Icon name="swap" size={24} />
        </div>
        <HomeTile home={x.theirHome} who={x.otherName ? L(`${x.otherName} 님의 집`, `${x.otherName}’s home`) : L('상대 집', 'Their home')} range={x.myStay} label={L('내가 머무는 기간', 'I stay')} />
      </div>
      <Stepper steps={labels} current={exchangeStep(x.status)} label={L('맞교환 진행 단계', 'Exchange progress')} />
    </header>
  );
}

/** "청소: 각자 퇴실 전 기본 청소" rows from the offer's free-form terms object. */
export function termRows(terms: Record<string, unknown>, L: (ko: string, en: string) => string): Array<[string, string]> {
  const LABELS: Record<string, [string, string]> = {
    cleaning: ['청소', 'Cleaning'],
    utilities: ['공과금', 'Utilities'],
    carIncluded: ['차량 이용', 'Car'],
    petCare: ['반려동물 돌봄', 'Pet care'],
    plantCare: ['식물 돌봄', 'Plant care'],
    keyHandover: ['열쇠 전달', 'Key handover'],
  };
  return Object.entries(terms ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const lbl = LABELS[k] ?? [k, k];
      const val = typeof v === 'boolean' ? (k === 'carIncluded' ? (v ? L('차량도 함께 이용', 'Car included') : L('차량 제외', 'No car')) : v ? L('부탁해요', 'Requested') : L('필요 없어요', 'Not needed')) : String(v);
      return [L(lbl[0], lbl[1]), val] as [string, string];
    });
}
