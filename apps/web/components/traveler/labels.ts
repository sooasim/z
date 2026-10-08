/**
 * Traveler-area copy helpers: localized labels for enums the traveler UI shows (roles, AAL, channels, payment
 * methods …), cancellation-policy sentences, address formatting, notification templates and milestone mapping.
 * Never show raw SNAKE_CASE / English API reasons in the Korean UI — route them through these helpers.
 */
import { formatDate, formatRange, formatTimeRange, type Lang } from '@/lib/format';
import { placeLabel, countryLabel } from '@/lib/places';
import { enumLabel } from '@/lib/enums';
import { arr, f, isObj, num, str } from '@/lib/shape';
import type { PriceLine } from '@/components/ui';

type Pair = readonly [string, string];
const pick = (p: Pair | undefined, lang: Lang) => (p ? p[lang === 'ko' ? 0 : 1] : undefined);

function lookup(map: Record<string, Pair>, v: unknown, lang: Lang): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  return pick(map[s.toUpperCase()], lang) ?? enumLabel(s, lang);
}

export const ROLE_LABEL: Record<string, Pair> = {
  USER: ['일반 회원', 'Member'],
  TRAVELER: ['여행자', 'Traveler'],
  HOST: ['호스트', 'Host'],
  GUIDE: ['가이드', 'Guide'],
  SUPPLIER: ['여행 공급사', 'Travel supplier'],
  ADMIN: ['관리자', 'Admin'],
  SUPPORT: ['고객지원', 'Support'],
  ACCOUNTING: ['회계', 'Accounting'],
  COMPLIANCE: ['컴플라이언스', 'Compliance'],
  EDITOR: ['콘텐츠 에디터', 'Editor'],
  OPS: ['운영', 'Operations'],
};
export const roleLabel = (r: unknown, lang: Lang) => lookup(ROLE_LABEL, r, lang);

/** Session assurance level in plain words (AAL1/AAL2 are NIST jargon). */
export function aalLabel(aal: unknown, lang: Lang): string {
  const a = String(aal ?? '').toLowerCase();
  if (a === 'aal2' || a === 'aal3') return lang === 'ko' ? '2단계 인증 완료' : 'Two-step verified';
  return lang === 'ko' ? '기본 (비밀번호)' : 'Standard (password)';
}

export const CHANNEL_LABEL: Record<string, Pair> = {
  IN_APP: ['앱 알림', 'In-app'],
  EMAIL: ['이메일', 'Email'],
  SMS: ['문자', 'SMS'],
  PUSH: ['푸시', 'Push'],
  KAKAO_ALIMTALK: ['카카오 알림톡', 'KakaoTalk'],
};
export const channelLabel = (c: unknown, lang: Lang) => lookup(CHANNEL_LABEL, c, lang);

export const PAYMENT_METHOD_LABEL: Record<string, Pair> = {
  CARD: ['카드', 'Card'],
  MOCK: ['테스트 결제', 'Test payment'],
  TRANSFER: ['계좌이체', 'Bank transfer'],
  BANK_TRANSFER: ['계좌이체', 'Bank transfer'],
  VIRTUAL_ACCOUNT: ['가상계좌', 'Virtual account'],
  EASY_PAY: ['간편결제', 'Easy pay'],
  MOBILE_PHONE: ['휴대폰 결제', 'Mobile phone'],
  TOSS: ['토스페이먼츠', 'TossPayments'],
  FREE: ['무료', 'Free'],
};
export const paymentMethodLabel = (m: unknown, lang: Lang) => lookup(PAYMENT_METHOD_LABEL, m, lang);

export const RECEIPT_TYPE_LABEL: Record<string, Pair> = {
  PAYMENT: ['결제 영수증', 'Payment receipt'],
  REFUND: ['환불 영수증', 'Refund receipt'],
  CANCEL: ['취소 영수증', 'Cancellation receipt'],
  TAX_INVOICE: ['세금계산서', 'Tax invoice'],
  CASH_RECEIPT: ['현금영수증', 'Cash receipt'],
};
export const receiptTypeLabel = (t: unknown, lang: Lang) => lookup(RECEIPT_TYPE_LABEL, t, lang);

/** Subject / context types a traveler can reference (support cases, disputes, payments). */
export const SUBJECT_LABEL: Record<string, Pair> = {
  RESERVATION: ['숙소 예약', 'Stay'],
  EXCHANGE: ['홈 맞교환', 'Home exchange'],
  GUIDE_BOOKING: ['가이드', 'Guide'],
  GUIDE_REQUEST: ['가이드 요청', 'Guide request'],
  ORDER: ['여행 상품', 'Travel product'],
  PAYMENT: ['결제', 'Payment'],
  ACCOUNT: ['계정', 'Account'],
  USER: ['회원', 'Member'],
  MESSAGE: ['메시지', 'Message'],
  INQUIRY: ['숙소 문의', 'Inquiry'],
  SUPPORT: ['고객센터', 'Support'],
  OTHER: ['기타', 'Other'],
};
export const subjectLabel = (t: unknown, lang: Lang) => lookup(SUBJECT_LABEL, t, lang);

export const VISIBILITY_LABEL: Record<string, Pair> = { PRIVATE: ['비공개', 'Private'], PUBLIC: ['공개', 'Public'], SHARED: ['링크 공유', 'Shared by link'], UNLISTED: ['링크 공유', 'Unlisted'] };
export const visibilityLabel = (v: unknown, lang: Lang) => lookup(VISIBILITY_LABEL, v || 'PRIVATE', lang);

export const SUPPORT_CATEGORY_LABEL: Record<string, Pair> = {
  BOOKING: ['예약', 'Booking'],
  PAYMENT: ['결제', 'Payment'],
  REFUND: ['환불', 'Refund'],
  EXCHANGE: ['맞교환', 'Exchange'],
  GUIDE: ['가이드', 'Guide'],
  HOSTING: ['호스팅', 'Hosting'],
  ACCOUNT: ['계정', 'Account'],
  SAFETY: ['안전', 'Safety'],
  TECHNICAL: ['기술 문제', 'Technical'],
  OTHER: ['기타', 'Other'],
};

export const DISPUTE_REASON_LABEL: Record<string, Pair> = {
  PROPERTY_NOT_AS_DESCRIBED: ['숙소가 설명과 다름', 'Not as described'],
  DAMAGE: ['파손·손해', 'Damage'],
  NO_SHOW: ['노쇼', 'No-show'],
  REFUND: ['환불 분쟁', 'Refund dispute'],
  HARASSMENT: ['괴롭힘·부적절한 행동', 'Harassment'],
  SAFETY: ['안전 위협', 'Safety threat'],
  FRAUD: ['사기 의심', 'Suspected fraud'],
  CLEANLINESS: ['청결 문제', 'Cleanliness'],
  NO_ACCESS: ['입실 불가', 'Could not get in'],
  GUIDE_NO_SHOW: ['가이드 미출석', 'Guide no-show'],
  PAYMENT_ISSUE: ['결제 문제', 'Payment issue'],
  OTHER: ['기타', 'Other'],
};

export const SEVERITY_LABEL: Record<string, Pair> = { LOW: ['낮음', 'Low'], NORMAL: ['보통', 'Normal'], MEDIUM: ['보통', 'Medium'], HIGH: ['높음', 'High'], URGENT: ['긴급', 'Urgent'], CRITICAL: ['긴급', 'Critical'] };

export const VERIFICATION_TYPE_LABEL: Record<string, Pair> = {
  IDENTITY: ['본인 확인', 'Identity'],
  HOST: ['호스트', 'Host'],
  GUIDE: ['가이드 자격', 'Guide credentials'],
  SUPPLIER: ['여행 공급사', 'Travel supplier'],
  BUSINESS: ['사업자', 'Business'],
  PAYOUT_ACCOUNT: ['정산 계좌', 'Payout account'],
  PROPERTY: ['숙소', 'Property'],
};

export const REVIEW_TARGET_LABEL: Record<string, Pair> = {
  PROPERTY: ['숙소', 'Stay'],
  HOST: ['호스트', 'Host'],
  GUIDE: ['가이드', 'Guide'],
  TRAVEL_PRODUCT: ['여행 상품', 'Travel product'],
  EXCHANGE_PARTNER: ['맞교환 상대', 'Exchange partner'],
  GUEST: ['게스트', 'Guest'],
  TRAVELER: ['여행자', 'Traveler'],
  USER: ['회원', 'Member'],
};

/** Short "next step" labels for exchange cards (the detail page has the long sentences). */
export const EXCHANGE_NEXT: Record<string, Pair> = {
  RESPOND: ['제안에 응답하기', 'Respond to offer'],
  AWAIT_RESPONSE: ['상대 응답 대기 중', 'Waiting for reply'],
  SAFETY_ACK: ['안전 수칙 확인하기', 'Review safety rules'],
  AWAIT_VERIFICATION: ['검증 진행 중', 'Verification in progress'],
  SIGN_AGREEMENT: ['계약서 서명하기', 'Sign agreement'],
  AWAIT_COUNTERPARTY_SIGNATURE: ['상대 서명 대기 중', 'Waiting for signature'],
  CONFIRM: ['맞교환 확정하기', 'Confirm exchange'],
  PREPARE_TRIP: ['여행 준비하기', 'Get ready'],
  COMPLETE_AFTER_STAY: ['이용 완료 처리하기', 'Mark as complete'],
  LEAVE_REVIEW: ['후기 남기기', 'Leave a review'],
};
export const exchangeNext = (k: unknown, lang: Lang) => pick(EXCHANGE_NEXT[String(k ?? '').toUpperCase()], lang) ?? '';

// ————————————————————————————————————————— cancellation policy

const POLICY_NAME: Record<string, Pair> = {
  FLEXIBLE: ['유연', 'Flexible'],
  MODERATE: ['보통', 'Moderate'],
  STRICT: ['엄격', 'Strict'],
  SUPER_STRICT: ['매우 엄격', 'Super strict'],
  NON_REFUNDABLE: ['환불 불가', 'Non-refundable'],
  LONG_TERM: ['장기 숙박', 'Long-term'],
};

/** "보통 (Moderate)" → '보통' (ko) / 'Moderate' (en); falls back to the policy code. */
export function policyName(policy: unknown, lang: Lang): string {
  if (!policy) return '';
  if (typeof policy === 'string') return pick(POLICY_NAME[policy.toUpperCase()], lang) ?? policy;
  const name = str(policy, 'name');
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(name);
  if (m) return lang === 'ko' ? m[1] : m[2];
  const code = str(policy, 'code');
  return pick(POLICY_NAME[code.toUpperCase()], lang) ?? (name || code);
}

export interface PolicyTier {
  pct: number;
  hours: number;
}
export function policyTiers(policy: unknown): PolicyTier[] {
  const raw = (isObj(policy) ? f<any[]>(policy, 'tiers') : Array.isArray(policy) ? policy : null) ?? [];
  return raw
    .map((t: any) => ({ pct: num(t, 'refund_pct', 'refundPct') ?? 0, hours: num(t, 'min_hours_before', 'minHoursBefore') ?? 0 }))
    .sort((a, b) => b.hours - a.hours);
}

function hoursText(h: number, lang: Lang): string {
  if (h >= 24 && h % 24 === 0) {
    const d = h / 24;
    return lang === 'ko' ? `${d}일` : `${d} day${d === 1 ? '' : 's'}`;
  }
  return lang === 'ko' ? `${h}시간` : `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * Tier sentences: ['체크인 5일 전까지 전액 환불', '1일 전까지 50% 환불', '이후 환불 불가'].
 * `anchor` names the reference moment (체크인 / 출발 / 시작).
 */
export function policySentences(policy: unknown, lang: Lang, anchor: 'checkin' | 'departure' | 'start' = 'checkin'): string[] {
  const tiers = policyTiers(policy);
  if (!tiers.length) return [];
  const a = anchor === 'checkin' ? (lang === 'ko' ? '체크인' : 'check-in') : anchor === 'departure' ? (lang === 'ko' ? '출발' : 'departure') : lang === 'ko' ? '시작' : 'start';
  const out: string[] = [];
  tiers.forEach((t, i) => {
    if (t.pct <= 0) {
      out.push(lang === 'ko' ? (i === 0 ? '환불 불가' : '이후 환불 불가') : i === 0 ? 'Non-refundable' : 'No refund after that');
      return;
    }
    const amount = t.pct >= 100 ? (lang === 'ko' ? '전액 환불' : 'full refund') : lang === 'ko' ? `${t.pct}% 환불` : `${t.pct}% refund`;
    if (t.hours <= 0) out.push(lang === 'ko' ? `${a} 전까지 ${amount}` : `${amount[0].toUpperCase()}${amount.slice(1)} until ${a}`);
    else if (lang === 'ko') out.push(i === 0 ? `${a} ${hoursText(t.hours, lang)} 전까지 ${amount}` : `${hoursText(t.hours, lang)} 전까지 ${amount}`);
    else out.push(`${amount[0].toUpperCase()}${amount.slice(1)} up to ${hoursText(t.hours, lang)} before ${a}`);
  });
  return out;
}

/** "15:00:00" → "15:00". */
export function hhmm(t: unknown): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// ————————————————————————————————————————— address

export interface AddressView {
  /** Street line (line1 + line2 when it is part of the address). */
  street: string;
  /** Secondary detail (unit, building, or a demo-data note). */
  detail: string;
  /** "서울 · 03058" / "Seoul 03058, South Korea". */
  locality: string;
  /** Single-line form for copy / calendar location. */
  oneLine: string;
}

/** Format an address object {line1,line2,postalCode,city,region,country} (or a string) for display. */
export function formatAddress(a: unknown, lang: Lang): AddressView | null {
  if (!a) return null;
  if (typeof a === 'string') return a.trim() ? { street: a.trim(), detail: '', locality: '', oneLine: a.trim() } : null;
  if (!isObj(a)) return null;
  const line1 = str(a, 'line1', 'street', 'address1');
  const line2 = str(a, 'line2', 'address2', 'detail');
  const city = str(a, 'city');
  const postal = str(a, 'postalCode', 'postcode', 'zip');
  const country = str(a, 'country', 'countryCode');
  if (!line1 && !city) return null;
  const cityL = placeLabel(city, lang);
  // Korean street lines already start with the city ("서울 종로구 …"); don't repeat it.
  const cityInLine = !!cityL && (line1.includes(cityL) || line1.includes(city));
  const locality = [!cityInLine ? cityL : '', postal, country && country !== 'KR' ? countryLabel(country, lang) : lang === 'en' && country ? countryLabel(country, lang) : ''].filter(Boolean).join(lang === 'ko' ? ' · ' : ', ');
  return {
    street: line1,
    detail: line2,
    locality,
    oneLine: [line1, line2 && !/데모|demo/i.test(line2) ? line2 : '', !cityInLine ? cityL : ''].filter(Boolean).join(', '),
  };
}

// ————————————————————————————————————————— reservation milestones

export interface Milestone {
  key: string;
  title: string;
  at?: string;
  note?: string;
}

/**
 * Turn the reservation FSM history into traveler milestones: 예약 요청 → 결제 완료 → 예약 확정 → 체크인 → 이용 완료
 * (or 취소 / 노쇼 / 만료). Internal steps (DRAFT/QUOTED/HELD/PAYMENT_PENDING) and English reasons are dropped.
 */
export function reservationMilestones(history: any[], lang: Lang): Milestone[] {
  const L = (ko: string, en: string) => (lang === 'ko' ? ko : en);
  const out: Milestone[] = [];
  const seen = new Set<string>();
  const push = (m: Milestone) => {
    if (seen.has(m.key)) return;
    seen.add(m.key);
    out.push(m);
  };
  for (const h of history) {
    const to = str(h, 'to', 'toState', 'to_state', 'status').toUpperCase();
    const at = str(h, 'at', 'createdAt', 'created_at');
    if (['DRAFT', 'QUOTED', 'HELD', 'REQUESTED'].includes(to)) push({ key: 'requested', title: L('예약 요청', 'Booking requested'), at });
    else if (to === 'PAYMENT_PENDING') push({ key: 'requested', title: L('예약 요청', 'Booking requested'), at });
    else if (to === 'CONFIRMED') {
      push({ key: 'paid', title: L('결제 완료', 'Payment completed'), at });
      push({ key: 'confirmed', title: L('예약 확정', 'Booking confirmed'), at, note: L('호스트에게 예약 정보가 전달됐어요', 'The host has your booking details') });
    } else if (to === 'CHECKED_IN') push({ key: 'checkin', title: L('체크인', 'Checked in'), at });
    else if (to === 'COMPLETED') push({ key: 'completed', title: L('이용 완료', 'Stay completed'), at });
    else if (to === 'CANCELLED' || to === 'CANCELED') push({ key: 'cancelled', title: L('예약 취소', 'Cancelled'), at, note: cancelReasonText(str(h, 'reason'), lang) });
    else if (to === 'NO_SHOW') push({ key: 'noshow', title: L('노쇼 처리', 'Marked as no-show'), at });
    else if (to === 'EXPIRED') push({ key: 'expired', title: L('결제 시간 만료', 'Payment window expired'), at, note: L('확보한 날짜가 해제됐어요', 'The dates were released') });
    else if (to === 'REFUNDED') push({ key: 'refunded', title: L('환불 완료', 'Refunded'), at });
  }
  return out;
}

/** Cancel reasons are stored as "CODE: free text" — localize the code, keep the user's own words. */
export function cancelReasonText(reason: string, lang: Lang): string | undefined {
  if (!reason) return undefined;
  const m = /^([A-Z_]{3,})(?::\s*(.*))?$/.exec(reason.trim());
  const CODES: Record<string, Pair> = {
    CHANGE_OF_PLANS: ['일정 변경', 'Change of plans'],
    HOST_ISSUE: ['숙소 문제', 'Issue with the stay'],
    EMERGENCY: ['긴급 상황', 'Emergency'],
    BUYER_REQUEST: ['구매자 요청', 'Buyer request'],
    USER_REQUEST: ['이용자 요청', 'User request'],
    OTHER: ['기타', 'Other'],
  };
  if (m) {
    const code = pick(CODES[m[1]], lang) ?? enumLabel(m[1], lang);
    return m[2] ? `${code} · ${m[2]}` : code;
  }
  // Free-form English system reasons are not shown in the Korean UI.
  if (lang === 'ko' && !/[가-힣]/.test(reason)) return undefined;
  return reason;
}

// ————————————————————————————————————————— notifications

/** Deep link for a notification from its data payload (exchangeId → /exchange/…, reservationId → /trips/… …). */
export function notificationHref(n: any): string {
  const key = str(n, 'templateKey', 'template').toLowerCase();
  const d = f<any>(n, 'data') ?? {};
  const id = (k: string) => str(d, k);
  const url = str(n, 'link', 'url', 'deepLink') || id('url');
  if (key.startsWith('review') && id('reservationId')) return `/reviews?subjectType=RESERVATION&subjectId=${id('reservationId')}&targetType=PROPERTY`;
  if (id('exchangeId')) return `/exchange/${id('exchangeId')}`;
  if (id('reservationId')) return `/trips/${id('reservationId')}`;
  if (id('orderId')) return `/orders/${id('orderId')}`;
  if (id('guideBookingId')) return `/guide-bookings/${id('guideBookingId')}`;
  if (key.startsWith('guide') && id('bookingId')) return `/guide-bookings/${id('bookingId')}`;
  if (id('guideRequestId')) return `/guide-requests/${id('guideRequestId')}`;
  if (key.startsWith('guide') && id('requestId')) return `/guide-requests/${id('requestId')}`;
  if (id('subjectType') && id('subjectId')) {
    const t = id('subjectType').toUpperCase();
    if (t === 'RESERVATION') return `/trips/${id('subjectId')}`;
    if (t === 'ORDER') return `/orders/${id('subjectId')}`;
    if (t === 'GUIDE_BOOKING') return `/guide-bookings/${id('subjectId')}`;
    if (t === 'EXCHANGE') return `/exchange/${id('subjectId')}`;
  }
  if (id('conversationId')) return `/messages?c=${id('conversationId')}`;
  if (key.startsWith('payment')) return '/payments';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return '';
}

const KNOWN_REASONS: Array<[RegExp, Pair]> = [
  [/payment window expired/i, ['결제 시간이 만료되었어요', 'The payment window expired']],
  [/card declined|declined/i, ['카드 승인이 거절되었어요', 'The card was declined']],
  [/insufficient/i, ['잔액이 부족해요', 'Insufficient funds']],
  [/cancel/i, ['결제가 취소되었어요', 'Payment was cancelled']],
];

/** "북촌 한옥 스테이 2026-11-10~2026-11-13" → "북촌 한옥 스테이 · 11월 10일 – 13일". */
export function prettyOrderName(name: string, lang: Lang): string {
  const m = /^(.*?)\s*(\d{4}-\d{2}-\d{2})\s*[~–-]\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(name || '');
  if (!m) return name;
  return `${m[1]} · ${formatRange(m[2], m[3], lang)}`;
}

/** Localized title/body for a notification (API bodies sometimes carry English sentences or raw numbers). */
export function notificationText(n: any, lang: Lang): { title: string; body: string } {
  const key = str(n, 'templateKey', 'template').toLowerCase();
  const d = f<any>(n, 'data') ?? {};
  const rawTitle = str(n, 'title', 'subject');
  const rawBody = str(n, 'body', 'message');
  const ko = lang === 'ko';
  const L = (k: string, e: string) => (ko ? k : e);
  const dates = str(d, 'checkIn') && str(d, 'checkOut') ? formatRange(str(d, 'checkIn'), str(d, 'checkOut'), lang) : '';
  switch (key) {
    case 'reservation.confirmed.guest':
      return { title: L('예약이 확정되었어요', 'Your booking is confirmed'), body: [str(d, 'code') && `${L('예약 번호', 'Booking')} ${str(d, 'code')}`, dates].filter(Boolean).join(' · ') || rawBody };
    case 'payment.approved': {
      const m = /^(.*?)\s*·\s*(\d+)\s*([A-Z]{3})\s*$/.exec(rawBody);
      const body = m ? `${prettyOrderName(m[1], lang)} · ${new Intl.NumberFormat(ko ? 'ko-KR' : 'en-US', { style: 'currency', currency: m[3], maximumFractionDigits: 0 }).format(Number(m[2]))}` : prettyOrderName(rawBody, lang);
      return { title: L('결제가 완료되었어요', 'Payment completed'), body };
    }
    case 'payment.failed': {
      const [what, why] = rawBody.split(/:\s*/, 2);
      const r = KNOWN_REASONS.find(([re]) => re.test(why ?? ''));
      const reason = r ? r[1][ko ? 0 : 1] : why && (!ko || /[가-힣]/.test(why)) ? why : '';
      return { title: L('결제가 완료되지 않았어요', 'Payment did not complete'), body: [what, reason].filter(Boolean).join(' · ') };
    }
    case 'guide.booking.confirmed':
      return { title: L('가이드 일정이 확정되었어요', 'Your guide session is confirmed'), body: ko && !/[가-힣]/.test(rawBody) ? '일정과 만남 장소를 확인해 보세요.' : rawBody };
    case 'guide.offer.received':
      return { title: L('가이드 제안이 도착했어요', 'You received a guide offer'), body: ko && !/[가-힣]/.test(rawBody) ? '제안 내용을 확인하고 수락하거나 조율해 보세요.' : rawBody || 'Review the offer and accept or ask for changes.' };
    case 'message.received':
      return { title: L('새 메시지', 'New message'), body: rawBody };
    case 'order.paid':
      return { title: L('주문이 결제되었어요', 'Order paid'), body: rawBody };
    default: {
      const body = ko && rawBody && !/[가-힣]/.test(rawBody) ? '' : rawBody;
      return { title: rawTitle || enumLabel(key, lang), body };
    }
  }
}

/** Bucket for notification date grouping. */
export function dayBucket(iso: string, now = new Date()): 'today' | 'week' | 'older' {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'older';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 'today';
  if (d.getTime() >= start - 6 * 86400000) return 'week';
  return 'older';
}

// ————————————————————————————————————————— devices

/** "Mozilla/5.0 (X11; Linux x86_64) … Chrome/141" → { browser: 'Chrome', os: 'Linux', mobile: false }. */
export function parseUserAgent(ua: string): { browser: string; os: string; mobile: boolean; label: string } {
  const s = ua || '';
  let browser = '';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/Whale\//.test(s)) browser = 'Whale';
  else if (/KAKAOTALK/i.test(s)) browser = 'KakaoTalk';
  else if (/NAVER/.test(s)) browser = 'NAVER';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/HeadlessChrome/.test(s)) browser = 'Chrome (Headless)';
  else if (/Chrome\/|CriOS/.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/^curl\//.test(s)) browser = 'curl';
  else if (/^node|undici|axios|okhttp|python/i.test(s)) browser = 'API';
  let os = '';
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux|X11/.test(s)) os = 'Linux';
  const mobile = /Mobile|iPhone|Android/.test(s) && !/iPad/.test(s);
  return { browser, os, mobile, label: [browser, os].filter(Boolean).join(' · ') };
}

// ————————————————————————————————————————— misc formatting

export function guideWhen(start: string, end: string, lang: Lang): string {
  return start ? formatTimeRange(start, end || null, lang) : '—';
}

export function shortDate(iso: string, lang: Lang): string {
  return formatDate(iso, lang);
}

/** Whole days from today (local) to an ISO date (negative = past). */
export function daysUntil(isoDay: string, now = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay || '');
  if (!m) return NaN;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t - today) / 86400000);
}

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** First Hangul-free check: true when an API string is English-only (hide it from the Korean UI). */
export function isLatinOnly(s: string): boolean {
  return !!s && !/[가-힣]/.test(s);
}

/** "11월 10일 (화)" / "Tue, Nov 10" — day label with weekday (no year). */
export function dayLabel(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (lang === 'ko') return `${d.getMonth() + 1}월 ${d.getDate()}일 (${new Intl.DateTimeFormat('ko-KR', { weekday: 'short' }).format(d)})`;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

/** Order price lines: items, then platform fee and tax from the server-side pricing snapshot. */
export function orderPriceLines(o: any, L: (ko: string, en: string) => string): PriceLine[] {
  const lines = arr<any>(o, 'items', 'lines', 'orderItems');
  const out: PriceLine[] = lines.map((l) => ({ label: `${str(l, 'title', 'productTitle', 'name')} × ${num(l, 'qty', 'quantity') ?? 1}`, amountMinor: num(l, 'amountMinor', 'totalMinor') ?? 0 }));
  const fee = num(o, 'pricing.platformFeeMinor');
  const tax = num(o, 'pricing.taxMinor');
  if (fee !== undefined || tax !== undefined) {
    if (fee) out.push({ label: L('서비스 수수료', 'Service fee'), amountMinor: fee });
    if (tax) out.push({ label: L('부가세', 'VAT'), amountMinor: tax });
  } else if (num(o, 'feeMinor')) out.push({ label: L('수수료·세금', 'Fees & tax'), amountMinor: num(o, 'feeMinor')! });
  return out;
}


/** Order statuses read from the buyer's point of view. */
export const ORDER_STATUS_LABELS: Record<string, [string, string]> = {
  PENDING: ['결제 대기', 'Awaiting payment'],
  CREATED: ['결제 대기', 'Awaiting payment'],
  PAID: ['결제 완료', 'Paid'],
  CONFIRMED: ['예약 확정', 'Confirmed'],
  FULFILLED: ['이용 완료', 'Completed'],
  EXPIRED: ['결제 시간 만료', 'Expired'],
};

/** "방금 · 5분 전 · 3시간 전 · 어제 · 10월 3일" (ko) / "now · 5m · 3h · Yesterday · Oct 3" (en). */
export function relTime(iso: string, lang: Lang, now = new Date()): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const diff = (now.getTime() - d.getTime()) / 1000;
  const ko = lang === 'ko';
  if (diff < 60) return ko ? '방금' : 'now';
  if (diff < 3600) return ko ? `${Math.floor(diff / 60)}분 전` : `${Math.floor(diff / 60)}m`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startToday) return ko ? `${Math.floor(diff / 3600)}시간 전` : `${Math.floor(diff / 3600)}h`;
  if (d.getTime() >= startToday - 86400000) return ko ? '어제' : 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return ko ? `${d.getMonth() + 1}월 ${d.getDate()}일` : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
  return formatDate(iso, lang);
}

/** "오후 2:34" / "2:34 PM". */
export function clockTime(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Day separator text: "오늘", "어제", "10월 8일 (목)". */
export function daySeparator(iso: string, lang: Lang, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const delta = Math.round((day(now) - day(d)) / 86400000);
  if (delta === 0) return lang === 'ko' ? '오늘' : 'Today';
  if (delta === 1) return lang === 'ko' ? '어제' : 'Yesterday';
  const base = dayLabel(todayIsoOf(d), lang);
  return d.getFullYear() === now.getFullYear() ? base : `${d.getFullYear()}${lang === 'ko' ? '년 ' : ', '}${base}`;
}
const todayIsoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Guide booking FSM → traveler-facing milestone titles (English API reasons are dropped). */
export const GUIDE_MILESTONE: Record<string, [string, string]> = {
  REQUESTED: ['요청 보냄', 'Request sent'],
  OFFERED: ['제안 도착', 'Offer received'],
  ACCEPTED: ['제안 수락', 'Offer accepted'],
  PAYMENT_PENDING: ['결제 대기', 'Awaiting payment'],
  CONFIRMED: ['일정 확정', 'Confirmed'],
  SCHEDULED: ['일정 확정', 'Scheduled'],
  IN_PROGRESS: ['진행 중', 'In progress'],
  COMPLETED: ['진행 완료', 'Completed'],
  REVIEWED: ['후기 작성 완료', 'Reviewed'],
  CANCELLED: ['일정 취소', 'Cancelled'],
  NO_SHOW: ['노쇼', 'No-show'],
  DISPUTED: ['분쟁 접수', 'Disputed'],
};

/** "10:00 성수역 집합 → 카페 2곳 → 서울숲 산책" → ['10:00 성수역 집합', '카페 2곳', '서울숲 산책']. */
export function itinerarySteps(text: string): string[] {
  return (text || '')
    .split(/\s*(?:→|->|\n|·)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}
