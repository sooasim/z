import { langName } from './art';
import { placeLabel } from './places';
import type { Lang } from './format';
import { translate } from './phrases';

/**
 * Label tuples in this file are written `[ko, en]`. Korean takes the first side; every other language takes the
 * English side translated by source string (lib/phrases.ts), falling back to English.
 */
const pick = (pair: readonly string[], lang: Lang): string =>
  lang === 'ko' ? String(pair[0]) : translate(String(pair[1]), lang);

/**
 * Localized labels for API enum values that are not FSM statuses (statuses live in components/ui/status.tsx):
 * payment subjects/methods, ledger entry types, fee rule types, domains, roles, audit categories/actions,
 * severities, dispute/refund reasons, evidence kinds, property/room types, channels, calendar block types …
 * Never show raw SNAKE_CASE in the Korean UI: use `enumLabel()` / <EnumText>.
 */
type Pair = readonly [string, string];

export const ENUM_LABELS: Record<string, Pair> = {
  // payment subjects & business objects
  RESERVATION: ['숙소 예약', 'Stay reservation'],
  RESERVATION_HOLD: ['예약 홀드', 'Reservation hold'],
  ORDER: ['여행 상품 주문', 'Travel order'],
  GUIDE_BOOKING: ['가이드 예약', 'Guide booking'],
  GUIDE_REQUEST: ['가이드 요청', 'Guide request'],
  EXCHANGE: ['홈 맞교환', 'Home exchange'],
  PROPERTY: ['숙소', 'Property'],
  TRAVEL_PRODUCT: ['여행 상품', 'Travel product'],
  TRAVEL_DEPARTURE: ['출발 일정', 'Departure'],
  TRAVEL_OPTION: ['상품 옵션', 'Product option'],
  PAYMENT: ['결제', 'Payment'],
  REFUND: ['환불', 'Refund'],
  SETTLEMENT: ['정산', 'Settlement'],
  SETTLEMENT_STATEMENT: ['정산서', 'Settlement statement'],
  PAYOUT: ['지급', 'Payout'],
  PAYOUT_ACCOUNT: ['지급 계좌', 'Payout account'],
  PAYOUT_HOLD: ['지급 보류', 'Payout hold'],
  DISPUTE: ['분쟁', 'Dispute'],
  SUPPORT_CASE: ['고객 문의', 'Support case'],
  CONVERSATION: ['대화', 'Conversation'],
  MESSAGE: ['메시지', 'Message'],
  REVIEW: ['후기', 'Review'],
  USER: ['회원', 'User'],
  SESSION: ['로그인 세션', 'Session'],
  MFA_FACTOR: ['2단계 인증 수단', 'MFA factor'],
  VERIFICATION: ['본인·자격 인증', 'Verification'],
  DOCUMENT: ['서류', 'Document'],
  MEDIA: ['미디어', 'Media'],
  INTEGRATION: ['외부 연동', 'Integration'],
  CONFIG: ['설정', 'Configuration'],
  FLAG: ['기능 플래그', 'Feature flag'],
  CMS: ['콘텐츠', 'Content'],
  CONTENT: ['콘텐츠', 'Content'],
  STORY: ['스토리', 'Story'],
  PAGE: ['페이지', 'Page'],
  FAQ: ['자주 묻는 질문', 'FAQ'],
  BANNER: ['배너', 'Banner'],
  DESTINATION: ['여행지', 'Destination'],
  CHARTER: ['전세기', 'Charter'],
  ELEVATED_ACCESS: ['임시 열람 권한', 'Elevated access'],
  // payment methods & providers
  CARD: ['카드', 'Card'],
  VIRTUAL_ACCOUNT: ['가상계좌', 'Virtual account'],
  TRANSFER: ['계좌이체', 'Bank transfer'],
  BANK_TRANSFER: ['계좌이체', 'Bank transfer'],
  MOBILE_PHONE: ['휴대폰 결제', 'Mobile phone'],
  EASY_PAY: ['간편결제', 'Easy pay'],
  GIFT_CERTIFICATE: ['상품권', 'Gift certificate'],
  FREE: ['무료', 'Free'],
  TOSS: ['토스페이먼츠', 'TossPayments'],
  MOCK: ['테스트 결제', 'Test (mock)'],
  // ledger / finance
  PAYMENT_APPROVED: ['결제 승인', 'Payment approved'],
  PAYMENT_CANCELLED: ['결제 취소', 'Payment cancelled'],
  REFUND_ISSUED: ['환불 처리', 'Refund issued'],
  REFUND_APPROVED: ['환불 승인', 'Refund approved'],
  PAYOUT_SENT: ['지급 완료', 'Payout sent'],
  HOST_FEE: ['호스트 수수료', 'Host fee'],
  GUEST_FEE: ['게스트 서비스 수수료', 'Guest service fee'],
  PLATFORM_FEE: ['플랫폼 수수료', 'Platform fee'],
  SERVICE_FEE: ['서비스 수수료', 'Service fee'],
  TAX: ['세금', 'Tax'],
  VAT: ['부가세', 'VAT'],
  WITHHOLDING: ['원천징수', 'Withholding'],
  HOST_CANCELLATION_PENALTY: ['호스트 취소 위약금', 'Host cancellation penalty'],
  CANCELLATION_REFUND: ['취소 환불', 'Cancellation refund'],
  GOODWILL: ['보상(굿윌)', 'Goodwill'],
  EXTRA_GUEST: ['추가 인원 요금', 'Extra guest fee'],
  WEEKLY_DISCOUNT: ['주간 할인', 'Weekly discount'],
  MONTHLY_DISCOUNT: ['월간 할인', 'Monthly discount'],
  WEEKEND: ['주말 요금', 'Weekend rate'],
  SEASON: ['시즌 요금', 'Seasonal rate'],
  PROMOTION: ['프로모션', 'Promotion'],
  REVENUE: ['매출', 'Revenue'],
  EXPENSE: ['비용', 'Expense'],
  LIABILITY: ['부채', 'Liability'],
  ASSET: ['자산', 'Asset'],
  EQUITY: ['자본', 'Equity'],
  TAX_EVIDENCE: ['세금계산서·증빙', 'Tax evidence'],
  INSURANCE: ['보험', 'Insurance'],
  CLEANING: ['청소', 'Cleaning'],
  CLEANING_FEE: ['청소비', 'Cleaning fee'],
  NIGHTLY: ['숙박 요금', 'Nightly rate'],
  DISCOUNT: ['할인', 'Discount'],
  // domains
  STAY: ['숙소', 'Stays'],
  GUIDE: ['가이드', 'Guides'],
  TRAVEL: ['여행 상품', 'Travel'],
  TOUR: ['투어', 'Tour'],
  TICKET: ['티켓', 'Ticket'],
  PACKAGE: ['패키지', 'Package'],
  ACTIVITY: ['액티비티', 'Activity'],
  TRANSPORT: ['교통', 'Transport'],
  '*': ['전체', 'All'],
  ALL: ['전체', 'All'],
  // roles
  ADMIN: ['관리자', 'Admin'],
  SUPPORT: ['고객지원', 'Support'],
  ACCOUNTING: ['회계', 'Accounting'],
  COMPLIANCE: ['컴플라이언스', 'Compliance'],
  EDITOR: ['에디터', 'Editor'],
  HOST: ['호스트', 'Host'],
  SUPPLIER: ['여행 공급사', 'Supplier'],
  TRAVELER: ['여행자', 'Traveler'],
  GUEST: ['게스트', 'Guest'],
  MEMBER: ['회원', 'Member'],
  STAFF: ['운영진', 'Staff'],
  EXCHANGE_PARTNER: ['맞교환 상대', 'Exchange partner'],
  BUYER: ['구매자', 'Buyer'],
  REQUESTER: ['요청자', 'Requester'],
  RESPONDER: ['응답자', 'Responder'],
  SYSTEM: ['시스템', 'System'],
  // guide types
  FRIEND: ['프렌드 (무료 교류)', 'Friend (free)'],
  VOLUNTEER: ['자원봉사', 'Volunteer'],
  PROFESSIONAL: ['전문 가이드', 'Professional'],
  // audit categories & actions
  SECURITY: ['보안', 'Security'],
  MONEY: ['금전', 'Money'],
  PERMISSION: ['권한', 'Permission'],
  PRIVACY: ['개인정보', 'Privacy'],
  MARKETING: ['마케팅', 'Marketing'],
  TRANSACTIONAL: ['거래 알림', 'Transactional'],
  GRANT: ['부여', 'Grant'],
  REVOKE: ['회수', 'Revoke'],
  RESTRICT: ['제한', 'Restrict'],
  BAN: ['이용 정지', 'Ban'],
  DELETE: ['삭제', 'Delete'],
  EXPORT: ['내보내기', 'Export'],
  APPLY: ['적용', 'Apply'],
  DRY_RUN: ['모의 실행', 'Dry run'],
  STATUS_CHANGE: ['상태 변경', 'Status change'],
  SEVERITY_CHANGE: ['심각도 변경', 'Severity change'],
  ASSIGNMENT: ['담당자 지정', 'Assignment'],
  COMMENT: ['댓글', 'Comment'],
  INTERNAL_NOTE: ['내부 메모', 'Internal note'],
  NOTE: ['메모', 'Note'],
  // severity & priority
  LOW: ['낮음', 'Low'],
  MEDIUM: ['보통', 'Medium'],
  NORMAL: ['보통', 'Normal'],
  HIGH: ['높음', 'High'],
  URGENT: ['긴급', 'Urgent'],
  CRITICAL: ['심각', 'Critical'],
  WARNING: ['경고', 'Warning'],
  // dispute reasons & evidence
  PROPERTY_NOT_AS_DESCRIBED: ['숙소가 설명과 다름', 'Not as described'],
  NOT_AS_DESCRIBED: ['설명과 다름', 'Not as described'],
  DAMAGE: ['파손', 'Damage'],
  CLEANLINESS: ['청결 문제', 'Cleanliness'],
  SAFETY: ['안전 문제', 'Safety'],
  SAFETY_REPORT: ['안전 신고', 'Safety report'],
  SAFETY_ACK: ['안전 수칙 확인', 'Safety acknowledgement'],
  NO_ACCESS: ['입실 불가', 'Could not get in'],
  HOST_CANCELLED: ['호스트 취소', 'Host cancelled'],
  GUEST_CANCELLED: ['게스트 취소', 'Guest cancelled'],
  GUIDE_NO_SHOW: ['가이드 미출석', 'Guide no-show'],
  PAYMENT_ISSUE: ['결제 문제', 'Payment issue'],
  OTHER: ['기타', 'Other'],
  GENERAL: ['일반', 'General'],
  PHOTO: ['사진', 'Photo'],
  IMAGE: ['이미지', 'Image'],
  VIDEO: ['동영상', 'Video'],
  TEXT: ['텍스트', 'Text'],
  LINK: ['링크', 'Link'],
  MESSAGE_REF: ['메시지 참조', 'Message reference'],
  OFFER_REF: ['제안 참조', 'Offer reference'],
  EVIDENCE: ['증빙', 'Evidence'],
  // verification & documents
  IDENTITY: ['신원 확인', 'Identity'],
  BUSINESS: ['사업자', 'Business'],
  BUSINESS_REGISTRATION: ['사업자등록증', 'Business registration'],
  TRAVEL_AGENCY_REGISTRATION: ['여행업 등록증', 'Travel agency registration'],
  GUIDE_LICENSE: ['가이드 자격증', 'Guide licence'],
  LOCATION: ['위치', 'Location'],
  INDIVIDUAL: ['개인', 'Individual'],
  SOLE_PROPRIETOR: ['개인사업자', 'Sole proprietor'],
  CORPORATION: ['법인', 'Corporation'],
  TOUR_OPERATOR: ['여행사', 'Tour operator'],
  // terms
  TERMS: ['이용약관', 'Terms'],
  EXCHANGE_TERMS: ['맞교환 약관', 'Exchange terms'],
  GUIDE_TERMS: ['가이드 약관', 'Guide terms'],
  REFUND_POLICY: ['환불 정책', 'Refund policy'],
  // property & room types
  APARTMENT: ['아파트', 'Apartment'],
  HOUSE: ['단독주택', 'House'],
  HANOK: ['한옥', 'Hanok'],
  VILLA: ['빌라', 'Villa'],
  STUDIO: ['원룸', 'Studio'],
  GUESTHOUSE: ['게스트하우스', 'Guesthouse'],
  ENTIRE: ['집 전체', 'Entire place'],
  PRIVATE_ROOM: ['개인실', 'Private room'],
  SHARED_ROOM: ['다인실', 'Shared room'],
  ROOM: ['객실', 'Room'],
  // channels
  EMAIL: ['이메일', 'Email'],
  SMS: ['문자(SMS)', 'SMS'],
  PUSH: ['앱 푸시', 'Push'],
  IN_APP: ['앱 알림', 'In-app'],
  KAKAO_ALIMTALK: ['카카오 알림톡', 'Kakao AlimTalk'],
  KAKAO: ['카카오', 'Kakao'],
  NAVER: ['네이버', 'Naver'],
  GOOGLE: ['Google', 'Google'],
  PASSWORD: ['비밀번호', 'Password'],
  TOTP: ['인증 앱(OTP)', 'Authenticator app'],
  EMAIL_OTP: ['이메일 인증 코드', 'Email code'],
  OAUTH: ['소셜 로그인', 'Social login'],
  // calendar blocks
  HOST_BLOCK: ['호스트 차단', 'Host block'],
  HOLD: ['결제 대기 홀드', 'Hold'],
  BLOCK: ['차단', 'Blocked'],
  MANUAL: ['수동 차단', 'Manual block'],
  ICAL: ['iCal 연동', 'iCal sync'],
  EXTERNAL: ['외부 채널', 'External'],
  // visibility
  PUBLIC: ['공개', 'Public'],
  PRIVATE: ['비공개', 'Private'],
  SHARED: ['공유', 'Shared'],
  INBOUND: ['수신', 'Inbound'],
  OUTBOUND: ['발신', 'Outbound'],
  LEGACY_WONT: ['WONT Travel Club (이전)', 'WONT Travel Club (legacy)'],
  JETPOOL: ['JETPOOL', 'JETPOOL'],
};

/** Dotted audit / event action keys (auth.login, mfa.verify_failed …). */
export const ACTION_LABELS: Record<string, Pair> = {
  'auth.login': ['로그인', 'Signed in'],
  'auth.logout': ['로그아웃', 'Signed out'],
  'auth.login_failed': ['로그인 실패', 'Sign-in failed'],
  'auth.signup': ['회원가입', 'Signed up'],
  'auth.refresh': ['세션 갱신', 'Session refreshed'],
  'auth.password_changed': ['비밀번호 변경', 'Password changed'],
  'auth.password_reset': ['비밀번호 재설정', 'Password reset'],
  'mfa.enroll': ['2단계 인증 등록', 'MFA enrolled'],
  'mfa.enrolled': ['2단계 인증 등록', 'MFA enrolled'],
  'mfa.verify': ['2단계 인증 확인', 'MFA verified'],
  'mfa.verified': ['2단계 인증 확인', 'MFA verified'],
  'mfa.verify_failed': ['2단계 인증 실패', 'MFA failed'],
  'mfa.disabled': ['2단계 인증 해제', 'MFA disabled'],
  'role.grant': ['권한 부여', 'Role granted'],
  'role.revoke': ['권한 회수', 'Role revoked'],
  'payment.approved': ['결제 승인', 'Payment approved'],
  'payment.refunded': ['환불 처리', 'Refunded'],
  'flag.updated': ['기능 플래그 변경', 'Flag changed'],
  'config.updated': ['설정 변경', 'Config changed'],
  'elevated_access.granted': ['임시 열람 권한 부여', 'Elevated access granted'],
  'message.read': ['메시지 열람', 'Message read'],
};

const PATTERNS: Array<[RegExp, (m: RegExpExecArray, ko: boolean) => string]> = [
  [/^GUEST_CANCELLED_POLICY_(\d+)$/, (m, ko) => (ko ? `게스트 취소 (환불 ${m[1]}%)` : `Guest cancelled (${m[1]}% refund)`)],
  [/^HOST_CANCELLED_(\w+)$/, (_m, ko) => (ko ? '호스트 취소' : 'Host cancelled')],
  [/^(\w+)_FEE$/, (m, ko) => (ko ? `${enumLabel(m[1], 'ko')} 수수료` : `${enumLabel(m[1], 'en')} fee`)],
];

/** "PAYMENT_APPROVED" → "Payment approved" (last-resort fallback for unknown values). */
export function humanizeEnum(v: string, lang: Lang = 'ko'): string {
  const s = String(v ?? '');
  if (!s) return '—';
  const known = ENUM_LABELS[s.toUpperCase()];
  if (known) return pick(known, lang);
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(s.toUpperCase());
    // Pattern labels interpolate values ("Guest cancelled (50% refund)"), so they stay English outside Korean.
    if (m) return fn(m, lang === 'ko');
  }
  return translate(s.replace(/[_.]+/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), lang);
}

/** True for values that look like machine enums/keys (SNAKE_CASE or dotted.action). */
export function isEnumLike(v: unknown): v is string {
  return typeof v === 'string' && (v === '*' || (v.length > 1 && v.length < 64 && (/^[A-Z][A-Z0-9_]*$/.test(v) || /^[a-z]+(\.[a-z_]+)+$/.test(v))));
}

/** Localized label for an enum value or dotted action key; returns the input unchanged when it is not enum-like. */
export function enumLabel(v: unknown, lang: Lang = 'ko'): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  const act = ACTION_LABELS[s];
  if (act) return pick(act, lang);
  if (!isEnumLike(s)) return s;
  if (s.includes('.')) {
    const [obj, ...rest] = s.split('.');
    const o = ENUM_LABELS[obj.toUpperCase()];
    const verb = rest.join(' ').replace(/_/g, ' ');
    return o ? `${pick(o, lang)} · ${verb}` : s;
  }
  return humanizeEnum(s, lang);
}

/** Known label only (no humanized fallback) — lets callers decide whether to localize automatically. */
export function knownEnumLabel(v: unknown, lang: Lang = 'ko'): string | undefined {
  if (typeof v !== 'string') return undefined;
  const a = ACTION_LABELS[v] ?? ENUM_LABELS[v];
  return a ? pick(a, lang) : undefined;
}


/**
 * Search "why this result" lines come from the API as English sentences (guide search). Translate the known
 * templates; drop lines that repeat what the card already shows (rating) or that cannot be localized.
 * Returns null when the line should not be shown.
 */
export function localizeExplanation(line: string, lang: Lang = 'ko'): string | null {
  const s = String(line ?? '').trim();
  if (!s) return null;
  const ko = lang === 'ko';
  let m: RegExpExecArray | null;
  if (/^Rated [\d.]+\/5$/.test(s)) return null; // the card already shows the rating
  if (/^No overlapping interests$/i.test(s)) return null;
  if (/^New guide \(no ratings yet\)$/i.test(s)) return ko ? '새로 합류한 가이드' : 'New guide';
  if ((m = /^Speaks (.+) \((\d+)\/(\d+) requested languages\)$/.exec(s))) {
    const names = m[1].split(/,\s*/).map((c) => langName(c, lang)).join(', ');
    return ko ? `${names} 가능` : `Speaks ${names}`;
  }
  if ((m = /^Shares interests: (.+)$/.exec(s))) return ko ? `관심사 일치: ${m[1]}` : `Shared interests: ${m[1]}`;
  if (/^Available for the whole requested time$/i.test(s)) return ko ? '요청한 시간 모두 가능' : 'Available the whole time';
  if (/^No published schedule; availability on request$/i.test(s)) return ko ? '일정은 문의 후 확정' : 'Availability on request';
  if (/^Not available for the requested time$/i.test(s)) return ko ? '요청한 시간에는 어려워요' : 'Not available then';
  if ((m = /^About ([\d.]+) km away$/.exec(s))) return ko ? `약 ${m[1]}km 거리` : `About ${m[1]} km away`;
  if ((m = /^Based in (.+)$/.exec(s))) return ko ? `${placeLabel(m[1], 'ko')} 활동` : `Based in ${m[1]}`;
  if (ko && !/[가-힣]/.test(s)) return null;
  return s;
}
