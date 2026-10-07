'use client';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

/** FSM state → tone + localized label. Covers Reservation, Exchange, GuideBooking, Payment, Refund, Settlement, Order, compliance. */
const STATES: Record<string, [Tone, string, string]> = {
  DRAFT: ['neutral', '임시저장', 'Draft'],
  QUOTED: ['neutral', '견적', 'Quoted'],
  HELD: ['warn', '날짜 확보', 'Held'],
  PAYMENT_PENDING: ['warn', '결제 대기', 'Payment pending'],
  CONFIRMED: ['ok', '확정', 'Confirmed'],
  CHECKED_IN: ['info', '체크인', 'Checked in'],
  COMPLETED: ['ok', '완료', 'Completed'],
  CANCELLED: ['danger', '취소', 'Cancelled'],
  CANCELED: ['danger', '취소', 'Cancelled'],
  NO_SHOW: ['danger', '노쇼', 'No-show'],
  EXPIRED: ['danger', '만료', 'Expired'],
  FAILED: ['danger', '실패', 'Failed'],
  REFUNDED: ['neutral', '환불됨', 'Refunded'],
  PARTIALLY_REFUNDED: ['neutral', '부분 환불', 'Partly refunded'],
  PROPOSED: ['warn', '제안됨', 'Proposed'],
  COUNTERED: ['warn', '역제안', 'Countered'],
  ACCEPTED: ['info', '수락됨', 'Accepted'],
  VERIFYING: ['warn', '검증 중', 'Verifying'],
  VERIFIED: ['ok', '검증 완료', 'Verified'],
  AGREEMENT_PENDING: ['warn', '서명 대기', 'Awaiting signatures'],
  SIGNED: ['ok', '서명 완료', 'Signed'],
  IN_PROGRESS: ['info', '진행 중', 'In progress'],
  DECLINED: ['danger', '거절', 'Declined'],
  REQUESTED: ['warn', '요청됨', 'Requested'],
  OPEN: ['info', '열림', 'Open'],
  OFFERED: ['info', '제안 도착', 'Offer received'],
  SCHEDULED: ['ok', '예정', 'Scheduled'],
  PENDING: ['warn', '대기', 'Pending'],
  READY: ['info', '준비됨', 'Ready'],
  APPROVED: ['ok', '승인', 'Approved'],
  DONE: ['ok', '완료', 'Done'],
  AUTHORIZED: ['info', '승인 대기', 'Authorized'],
  CAPTURED: ['ok', '결제 완료', 'Captured'],
  PAID: ['ok', '결제 완료', 'Paid'],
  PAID_OUT: ['ok', '지급 완료', 'Paid out'],
  PROCESSING: ['warn', '처리 중', 'Processing'],
  REJECTED: ['danger', '반려', 'Rejected'],
  SUBMITTED: ['warn', '제출됨', 'Submitted'],
  IN_REVIEW: ['warn', '심사 중', 'In review'],
  UNDER_REVIEW: ['warn', '심사 중', 'In review'],
  NEEDS_INFO: ['warn', '보완 요청', 'Needs info'],
  PUBLISHED: ['ok', '게시됨', 'Published'],
  UNPUBLISHED: ['neutral', '비공개', 'Unpublished'],
  SUSPENDED: ['danger', '정지', 'Suspended'],
  ACTIVE: ['ok', '활성', 'Active'],
  INACTIVE: ['neutral', '비활성', 'Inactive'],
  PASS: ['ok', '적합', 'Pass'],
  PASSED: ['ok', '적합', 'Pass'],
  FAIL: ['danger', '부적합', 'Fail'],
  BLOCKED: ['danger', '차단', 'Blocked'],
  ELIGIBLE: ['ok', '자격 충족', 'Eligible'],
  INELIGIBLE: ['danger', '자격 미달', 'Ineligible'],
  RESOLVED: ['ok', '해결', 'Resolved'],
  ESCALATED: ['danger', '에스컬레이션', 'Escalated'],
  DISPUTED: ['danger', '분쟁', 'Disputed'],
  SETTLED: ['ok', '정산 완료', 'Settled'],
  CALCULATED: ['info', '산정됨', 'Calculated'],
  ON: ['ok', 'ON', 'ON'],
  OFF: ['neutral', 'OFF', 'OFF'],
  CURRENT: ['info', '현재 기기', 'This device'],
};

export function statusTone(status: string): Tone {
  return STATES[(status || '').toUpperCase()]?.[0] ?? 'neutral';
}

export function StatusPill({ status, live }: { status: string | undefined | null; live?: boolean }) {
  const { lang } = useI18n();
  if (!status) return <span className="pill neutral">—</span>;
  const s = String(status).toUpperCase();
  const def = STATES[s];
  const label = def ? (lang === 'ko' ? def[1] : def[2]) : s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  return (
    <span className={`pill ${def?.[0] ?? 'neutral'} ${live ? 'live' : ''}`} title={s}>
      {label}
    </span>
  );
}

export function Badge({ tone, children, icon }: { tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'exchange' | 'solid'; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone ?? ''}`}>
      {icon}
      {children}
    </span>
  );
}
