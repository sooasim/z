import { StateMachine } from '../../platform/fsm.js';

/** STAY-09 enumerated reservation state machine (whitepaper §7.1). */
export type ReservationStatus =
  | 'DRAFT'
  | 'QUOTED'
  | 'HELD'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'NO_SHOW'
  | 'DISPUTED';

export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  DRAFT: ['QUOTED'],
  QUOTED: ['HELD'],
  HELD: ['PAYMENT_PENDING', 'PAYMENT_FAILED', 'EXPIRED'],
  PAYMENT_PENDING: ['CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'EXPIRED'],
  EXPIRED: [],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['COMPLETED', 'DISPUTED'],
  COMPLETED: ['DISPUTED'],
  CANCELLED: ['REFUND_PENDING'],
  REFUND_PENDING: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: [],
  REFUNDED: [],
  NO_SHOW: [],
  DISPUTED: [],
};

export const reservationMachine = new StateMachine<ReservationStatus>('RESERVATION', RESERVATION_TRANSITIONS);

export type HoldStatus = 'ACTIVE' | 'CONVERTED' | 'RELEASED' | 'EXPIRED';
export const holdMachine = new StateMachine<HoldStatus>('RESERVATION_HOLD', {
  ACTIVE: ['CONVERTED', 'RELEASED', 'EXPIRED'],
  CONVERTED: [],
  RELEASED: [],
  EXPIRED: [],
});

/** Statuses after which the exact address may be revealed to the guest. */
export const ADDRESS_VISIBLE: ReservationStatus[] = ['CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW', 'DISPUTED'];
export const PRE_CONFIRMATION: ReservationStatus[] = ['DRAFT', 'QUOTED', 'HELD', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'EXPIRED'];
