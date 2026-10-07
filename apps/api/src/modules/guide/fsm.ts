import { StateMachine } from '../../platform/fsm.js';

export type GuideType = 'FRIEND' | 'VOLUNTEER' | 'PAID' | 'PROFESSIONAL';
export const GUIDE_TYPES = ['FRIEND', 'VOLUNTEER', 'PAID', 'PROFESSIONAL'] as const;
export const FREE_GUIDE_TYPES: readonly GuideType[] = ['FRIEND', 'VOLUNTEER'];
export const PAID_GUIDE_TYPES: readonly GuideType[] = ['PAID', 'PROFESSIONAL'];
export const isPaidType = (t: string) => (PAID_GUIDE_TYPES as readonly string[]).includes(t);

export type GuideRequestStatus = 'REQUESTED' | 'OFFERED' | 'COUNTERED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

/** GUIDE-04 request/offer negotiation. Self-transitions (OFFERED→OFFERED) mean a revised offer version. */
export const GuideRequestFsm = new StateMachine<GuideRequestStatus>('GUIDE_REQUEST', {
  REQUESTED: ['OFFERED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  OFFERED: ['OFFERED', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  COUNTERED: ['COUNTERED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: [],
  DECLINED: [],
  CANCELLED: [],
  EXPIRED: [],
});
export const OPEN_REQUEST_STATUSES: GuideRequestStatus[] = ['REQUESTED', 'OFFERED', 'COUNTERED'];

export type GuideBookingStatus =
  | 'ACCEPTED' | 'PAYMENT_PENDING' | 'PAYMENT_FAILED' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'REVIEWED' | 'CANCELLED' | 'DISPUTED';

/**
 * GUIDE-05 booking FSM (separate from Reservation/Exchange, invariant 2).
 * ACCEPTED → [PAID: PAYMENT_PENDING → CONFIRMED | PAYMENT_FAILED] | [FREE: CONFIRMED] → IN_PROGRESS → COMPLETED → REVIEWED;
 * CANCELLED / DISPUTED from any active state. ACCEPTED→CONFIRMED is only taken for free bookings (enforced in service).
 */
export const GuideBookingFsm = new StateMachine<GuideBookingStatus>('GUIDE_BOOKING', {
  ACCEPTED: ['CONFIRMED', 'PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'CANCELLED'],
  CONFIRMED: ['IN_PROGRESS', 'CANCELLED', 'DISPUTED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'DISPUTED'],
  COMPLETED: ['REVIEWED', 'DISPUTED'],
  REVIEWED: ['DISPUTED'],
  CANCELLED: [],
  DISPUTED: [],
});

/** Statuses that occupy the guide's time (mirrors the DB exclusion constraint predicate). */
export const ACTIVE_BOOKING_STATUSES: GuideBookingStatus[] = ['ACCEPTED', 'PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS'];
export const CANCELLABLE_BOOKING_STATUSES: GuideBookingStatus[] = ['ACCEPTED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'CONFIRMED', 'IN_PROGRESS'];
export const DISPUTABLE_BOOKING_STATUSES: GuideBookingStatus[] = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'];
