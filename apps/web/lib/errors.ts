/** RFC 7807 problem+json → typed client error. `code` is the stable machine identifier from the API. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  message?: string;
  details?: unknown;
  errors?: unknown;
  correlationId?: string;
}

export type ErrorKind = 'unauthenticated' | 'forbidden' | 'mfa_required' | 'not_found' | 'conflict' | 'validation' | 'rate_limited' | 'disabled' | 'network' | 'server';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;
  constructor(status: number, problem: Problem) {
    super(problem.detail || problem.message || problem.title || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code || defaultCode(status);
    this.problem = problem;
  }
  get kind(): ErrorKind {
    return classifyError(this.status, this.code);
  }
}

export function defaultCode(status: number): string {
  if (status === 0) return 'NETWORK_ERROR';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422 || status === 400) return 'INVALID_INPUT';
  if (status === 429) return 'RATE_LIMITED';
  return 'SERVER_ERROR';
}

export function classifyError(status: number, code?: string): ErrorKind {
  if (code === 'AAL2_REQUIRED' || code === 'MFA_REQUIRED') return 'mfa_required';
  if (code === 'FEATURE_DISABLED' || code === 'FLAG_DISABLED' || code?.endsWith('_DISABLED')) return 'disabled';
  if (status === 0) return 'network';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  return 'server';
}

export async function problemFromResponse(res: Response): Promise<Problem> {
  const text = await res.text().catch(() => '');
  if (!text) return { status: res.status };
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      const p = j as Problem & { error?: string | Problem };
      if (p.error && typeof p.error === 'object') return { status: res.status, ...p.error };
      return { status: res.status, ...p, detail: p.detail ?? p.message ?? (typeof p.error === 'string' ? p.error : undefined) };
    }
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, detail: text.slice(0, 300) };
}

/** Localised, user-facing message for a code (fallback to server detail). */
const MESSAGES: Record<string, { ko: string; en: string }> = {
  NETWORK_ERROR: { ko: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', en: 'Cannot reach the server. Please try again.' },
  UNAUTHENTICATED: { ko: '로그인이 필요합니다.', en: 'Please sign in.' },
  FORBIDDEN: { ko: '이 작업을 수행할 권한이 없습니다.', en: 'You do not have permission for this action.' },
  AAL2_REQUIRED: { ko: '이 작업에는 2단계 인증(MFA)이 필요합니다.', en: 'Multi-factor authentication is required.' },
  NOT_FOUND: { ko: '요청한 항목을 찾을 수 없습니다.', en: 'Not found.' },
  INVENTORY_UNAVAILABLE: { ko: '선택한 날짜는 더 이상 예약할 수 없습니다.', en: 'Those dates are no longer available.' },
  GUIDE_UNAVAILABLE: { ko: '가이드가 해당 시간에 이미 예약되어 있습니다.', en: 'The guide is already booked for that time.' },
  QUOTE_EXPIRED: { ko: '견적이 만료되었습니다. 다시 견적을 받아 주세요.', en: 'The quote expired. Please re-quote.' },
  HOLD_EXPIRED: { ko: '예약 홀드가 만료되었습니다.', en: 'Your hold has expired.' },
  VERSION_CONFLICT: { ko: '다른 변경이 먼저 반영되었습니다. 새로고침 후 다시 시도해 주세요.', en: 'Someone changed this first. Refresh and retry.' },
  STALE_VERSION: { ko: '다른 변경이 먼저 반영되었습니다. 새로고침 후 다시 시도해 주세요.', en: 'Someone changed this first. Refresh and retry.' },
  COMPLIANCE_BLOCKED: { ko: '필수 인허가/준수 요건이 충족되지 않았습니다.', en: 'Required compliance checks are not satisfied.' },
  FEATURE_DISABLED: { ko: '현재 제공되지 않는 기능입니다 (운영 정책상 비활성화).', en: 'This feature is currently disabled.' },
  IDEMPOTENCY_KEY_REQUIRED: { ko: '요청 식별 키가 누락되었습니다.', en: 'Idempotency key missing.' },
  RATE_LIMITED: { ko: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', en: 'Too many requests. Slow down.' },
  INVALID_CREDENTIALS: { ko: '이메일 또는 비밀번호가 올바르지 않습니다.', en: 'Invalid email or password.' },
  INVALID_INPUT: { ko: '입력값을 확인해 주세요.', en: 'Please check your input.' },
  DUPLICATE: { ko: '이미 존재하는 항목입니다.', en: 'Already exists.' },
  SERVER_ERROR: { ko: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', en: 'Something went wrong. Please try again.' },
  INVALID_STATE_TRANSITION: { ko: '현재 상태에서는 이 작업을 할 수 없습니다. 새로고침해 주세요.', en: 'This action is not possible in the current state. Refresh the page.' },
  NOT_A_PARTY: { ko: '이 거래의 당사자만 할 수 있습니다.', en: 'Only parties to this transaction can do that.' },
  ROLE_REQUIRED: { ko: '해당 역할(호스트/가이드/공급사 등)이 필요합니다.', en: 'A partner role is required for this action.' },
  ACCOUNT_SUSPENDED: { ko: '계정이 일시 정지되었습니다. 고객센터에 문의해 주세요.', en: 'Your account is suspended. Contact support.' },
  NOT_ELIGIBLE: { ko: '아직 맞교환 자격 요건을 충족하지 않았습니다. 맞교환 설정에서 남은 항목을 완료해 주세요.', en: 'You are not eligible for Home Exchange yet. Finish the remaining items in your exchange setup.' },
  COUNTERPARTY_NOT_ELIGIBLE: { ko: '상대 회원이 현재 맞교환 자격을 갖추지 않았습니다.', en: 'The other member is not currently eligible for exchange.' },
  PROPERTY_NOT_EXCHANGEABLE: { ko: '내 집이 맞교환용으로 공개되지 않았습니다.', en: 'Your home is not published for exchange.' },
  SELF_EXCHANGE: { ko: '내 집과는 맞교환할 수 없습니다.', en: 'You cannot exchange with yourself.' },
  SAME_PROPERTY: { ko: '서로 다른 두 집을 선택해 주세요.', en: 'Choose two different homes.' },
  DATES_IN_PAST: { ko: '지난 날짜는 선택할 수 없습니다.', en: 'Dates must not be in the past.' },
  START_IN_PAST: { ko: '지난 시간은 선택할 수 없습니다.', en: 'The start time is in the past.' },
  TOO_MANY_GUESTS: { ko: '최대 인원을 초과했습니다.', en: 'Too many guests for this home.' },
  PARTY_TOO_LARGE: { ko: '인원이 너무 많습니다.', en: 'The party is too large.' },
  OFFER_VERSION_MISMATCH: { ko: '조건이 변경되었습니다. 최신 제안을 확인해 주세요.', en: 'The offer changed. Review the latest version.' },
  NOT_YOUR_TURN: { ko: '상대방의 응답을 기다리는 중입니다.', en: 'Waiting for the other party to respond.' },
  AGREEMENT_NOT_SIGNED: { ko: '양측 서명이 완료되어야 확정할 수 있습니다.', en: 'Both parties must sign first.' },
  AGREEMENT_STALE: { ko: '계약서가 최신 조건과 다릅니다. 새로고침해 주세요.', en: 'The agreement is out of date. Refresh.' },
  ALREADY_SIGNED: { ko: '이미 서명했습니다.', en: 'Already signed.' },
  ALREADY_PAID: { ko: '이미 결제가 완료되었습니다.', en: 'Already paid.' },
  NOT_PAYABLE: { ko: '지금은 결제할 수 없는 상태입니다.', en: 'This cannot be paid right now.' },
  ORDER_NOT_PAYABLE: { ko: '지금은 결제할 수 없는 주문입니다.', en: 'This order cannot be paid right now.' },
  NOTHING_TO_PAY: { ko: '결제할 금액이 없습니다.', en: 'Nothing to pay.' },
  PAYMENT_IN_PROGRESS: { ko: '결제가 진행 중입니다. 잠시 후 확인해 주세요.', en: 'A payment is already in progress.' },
  PAYMENT_AMOUNT_MISMATCH: { ko: '결제 금액이 일치하지 않아 승인하지 않았습니다.', en: 'Payment amount mismatch — not approved.' },
  PRODUCT_UNAVAILABLE: { ko: '판매가 마감된 상품입니다.', en: 'This product is no longer available.' },
  GUIDE_NOT_AVAILABLE: { ko: '가이드가 해당 시간에 활동하지 않습니다.', en: 'The guide is not available then.' },
  FREE_GUIDE_PRICE_NOT_ALLOWED: { ko: '프렌드/봉사 가이드는 요금을 받을 수 없습니다.', en: 'Friend/volunteer guides cannot charge.' },
  MEDIA_TYPE_NOT_ALLOWED: { ko: '허용되지 않는 파일 형식입니다.', en: 'File type not allowed.' },
  MEDIA_TOO_LARGE: { ko: '파일이 너무 큽니다.', en: 'File too large.' },
  PUBLISH_VALIDATION_FAILED: { ko: '공개 전 필수 항목을 채워 주세요.', en: 'Complete the required items before publishing.' },
  MAKER_CHECKER_VIOLATION: { ko: '요청자와 승인자는 달라야 합니다 (4-eyes).', en: 'Maker and checker must be different people.' },
  FOUR_EYES_REQUIRED: { ko: '다른 관리자의 승인이 필요합니다 (4-eyes).', en: 'A second approver is required.' },
  ELEVATED_ACCESS_REQUIRED: { ko: '사건 범위의 임시 열람 권한이 필요합니다.', en: 'Case-scoped elevated access is required.' },
  REASON_REQUIRED: { ko: '사유를 입력해 주세요.', en: 'A reason is required.' },
  IDEMPOTENCY_KEY_REUSED: { ko: '같은 요청이 다른 내용으로 재사용되었습니다. 새로고침 후 다시 시도해 주세요.', en: 'Request key reused with different content. Refresh and retry.' },
  IDEMPOTENCY_IN_PROGRESS: { ko: '같은 요청을 처리 중입니다. 잠시만 기다려 주세요.', en: 'This request is already being processed.' },
  // — accounts & sign-in —
  EMAIL_TAKEN: { ko: '이미 가입된 이메일입니다. 로그인하거나 비밀번호를 재설정해 주세요.', en: 'An account with this email already exists. Log in or reset your password.' },
  WEAK_PASSWORD: { ko: '비밀번호는 10자 이상, 영문과 숫자를 함께 사용해 주세요.', en: 'Use at least 10 characters with letters and numbers.' },
  ACCOUNT_LOCKED: { ko: '로그인 시도가 너무 많아 잠시 잠겼습니다. 잠시 후 다시 시도하거나 비밀번호를 재설정해 주세요.', en: 'Too many attempts — your account is temporarily locked. Try again later or reset your password.' },
  MFA_LOCKED: { ko: '인증 코드 입력 오류가 반복되어 잠시 잠겼습니다. 잠시 후 다시 시도해 주세요.', en: 'Too many wrong codes. Try again in a few minutes.' },
  TOO_MANY_ATTEMPTS: { ko: '시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', en: 'Too many attempts. Try again later.' },
  MFA_CODE_INVALID: { ko: '인증 코드가 올바르지 않습니다. 앱의 최신 6자리 코드를 입력하세요.', en: 'That code is not valid. Enter the latest 6-digit code from your app.' },
  MFA_CODE_REQUIRED: { ko: '인증 앱의 6자리 코드를 입력하세요.', en: 'Enter the 6-digit code from your authenticator app.' },
  MFA_REQUIRED: { ko: '이 작업에는 2단계 인증(MFA)이 필요합니다.', en: 'Multi-factor authentication is required.' },
  MFA_NOT_ENROLLED: { ko: '먼저 계정 보안에서 인증 앱(OTP)을 등록해 주세요.', en: 'Set up an authenticator app in Account security first.' },
  MFA_ALREADY_ENROLLED: { ko: '이미 2단계 인증이 등록되어 있습니다.', en: 'MFA is already set up.' },
  REFRESH_TOKEN_INVALID: { ko: '로그인이 만료되었습니다. 다시 로그인해 주세요.', en: 'Your session expired. Please sign in again.' },
  REFRESH_TOKEN_REUSED: { ko: '보안을 위해 로그아웃되었습니다. 다시 로그인해 주세요.', en: 'You were signed out for security. Please sign in again.' },
  NO_EMAIL: { ko: '소셜 계정에서 이메일을 받지 못했습니다. 이메일 제공에 동의해 주세요.', en: 'The social account did not share an email address.' },
  OAUTH_NOT_CONFIGURED: { ko: '이 소셜 로그인은 아직 준비 중입니다. 이메일로 가입해 주세요.', en: 'This social login is not available yet. Use email instead.' },
  OAUTH_STATE_INVALID: { ko: '로그인 요청이 만료되었습니다. 다시 시도해 주세요.', en: 'The sign-in request expired. Please try again.' },
  OAUTH_CODE_INVALID: { ko: '소셜 로그인에 실패했습니다. 다시 시도해 주세요.', en: 'Social sign-in failed. Please try again.' },
  OAUTH_IDENTITY_IN_USE: { ko: '이 소셜 계정은 이미 다른 JETPOOL 계정에 연결되어 있습니다.', en: 'This social account is linked to another JETPOOL account.' },
  PROVIDER_ALREADY_LINKED: { ko: '이미 연결된 소셜 계정입니다.', en: 'Already linked.' },
  LAST_LOGIN_METHOD: { ko: '마지막 로그인 수단은 해제할 수 없습니다. 먼저 비밀번호를 설정해 주세요.', en: 'You cannot remove your last sign-in method.' },
  USER_DELETED: { ko: '탈퇴 처리된 계정입니다.', en: 'This account was deleted.' },
  INVALID_BIRTH_YEAR: { ko: '출생 연도를 확인해 주세요.', en: 'Check the birth year.' },
  // — partner roles —
  GUIDE_REQUIRED: { ko: '공개된 가이드 프로필이 있어야 요청을 볼 수 있어요. 가이드 프로필을 완성하고 공개해 주세요.', en: 'Publish your guide profile to browse open requests.' },
  GUIDE_PUBLICATION_DENIED: { ko: '공개 요건을 아직 충족하지 않았습니다. 체크리스트의 남은 항목을 완료해 주세요.', en: 'Publishing requirements are not met yet. Complete the remaining checklist items.' },
  GUIDE_PAID_GATE_FAILED: { ko: '유료 가이드로 공개하려면 자격 서류와 정산 계좌 등록이 필요합니다.', en: 'Paid guides need verified qualifications and a payout account.' },
  QUALIFICATION_MISSING: { ko: '필요한 자격 서류가 등록되지 않았습니다.', en: 'A required qualification is missing.' },
  QUALIFICATION_EXPIRED: { ko: '자격 서류의 유효기간이 지났습니다. 새 서류를 등록해 주세요.', en: 'A qualification has expired. Upload a new one.' },
  GUIDE_SUSPENDED: { ko: '가이드 활동이 일시 정지되었습니다. 고객센터에 문의해 주세요.', en: 'Your guide profile is suspended. Contact support.' },
  SUPPLIER_REQUIRED: { ko: '여행 공급사 계정이 필요합니다.', en: 'A supplier account is required.' },
  SUPPLIER_NOT_APPROVED: { ko: '공급사 심사가 완료된 뒤 이용할 수 있어요.', en: 'Available once your supplier account is approved.' },
  SUPPLIER_EXISTS: { ko: '이미 공급사로 등록되어 있습니다.', en: 'You are already registered as a supplier.' },
  NOT_PROPERTY_OWNER: { ko: '내 숙소에서만 할 수 있는 작업입니다.', en: 'Only the listing owner can do that.' },
  COMPLIANCE_DENIED: { ko: '인허가 요건이 충족되지 않아 유료 숙소로 게시할 수 없습니다.', en: 'Compliance requirements are not met for paid listing.' },
  PROPERTY_NOT_BOOKABLE: { ko: '지금은 예약을 받을 수 없는 숙소입니다.', en: 'This stay cannot be booked right now.' },
  PRICE_NOT_SET: { ko: '요금을 먼저 설정해 주세요.', en: 'Set a price first.' },
  PRICE_REQUIRED: { ko: '요금을 입력해 주세요.', en: 'A price is required.' },
  PAYOUT_ACCOUNT_REQUIRED: { ko: '정산 계좌를 먼저 등록해 주세요.', en: 'Add a payout account first.' },
  PAYOUT_HELD: { ko: '정산이 보류되었습니다. 고객센터에 문의해 주세요.', en: 'Payouts are on hold. Contact support.' },
  INTEGRATION_PAUSED: { ko: '연동이 일시 중지되어 있습니다.', en: 'This integration is paused.' },
  INVALID_ICAL_URL: { ko: 'iCal 주소를 확인해 주세요.', en: 'Check the iCal URL.' },
  SLUG_UNAVAILABLE: { ko: '이미 사용 중인 주소입니다. 다른 주소를 입력해 주세요.', en: 'That URL is taken.' },
  SLUG_CONFLICT: { ko: '이미 사용 중인 주소입니다. 다른 주소를 입력해 주세요.', en: 'That URL is taken.' },
  MEDIA_REQUIRED: { ko: '사진을 1장 이상 올려 주세요.', en: 'Add at least one photo.' },
  MEDIA_NOT_READY: { ko: '사진을 처리하는 중입니다. 잠시 후 다시 시도해 주세요.', en: 'The photo is still processing.' },
  // — booking & payments —
  INVALID_DATE_RANGE: { ko: '날짜를 다시 확인해 주세요. 체크아웃은 체크인 이후여야 합니다.', en: 'Check the dates — check-out must be after check-in.' },
  INVALID_RANGE: { ko: '날짜 범위를 확인해 주세요.', en: 'Check the date range.' },
  RANGE_TOO_LARGE: { ko: '선택한 기간이 너무 깁니다.', en: 'That range is too long.' },
  MIN_NIGHTS: { ko: '최소 숙박일수보다 짧습니다.', en: 'Below the minimum stay.' },
  MAX_NIGHTS: { ko: '최대 숙박일수를 초과했습니다.', en: 'Above the maximum stay.' },
  MAX_GUESTS_EXCEEDED: { ko: '최대 인원을 초과했습니다.', en: 'Too many guests.' },
  DATE_IN_PAST: { ko: '지난 날짜는 선택할 수 없습니다.', en: 'Dates must not be in the past.' },
  QUOTE_STALE: { ko: '요금이 변경되었습니다. 최신 요금을 확인해 주세요.', en: 'The price changed. Review the latest quote.' },
  SOLD_OUT: { ko: '매진되었습니다.', en: 'Sold out.' },
  DEPARTURE_CLOSED: { ko: '판매가 마감된 출발 일정입니다.', en: 'This departure is closed.' },
  ORDER_EXPIRED: { ko: '주문 유효시간이 지났습니다. 다시 주문해 주세요.', en: 'The order expired. Please order again.' },
  RESERVATION_NOT_PAYABLE: { ko: '지금은 결제할 수 없는 예약입니다.', en: 'This reservation cannot be paid right now.' },
  PAYMENT_FAILED: { ko: '결제가 승인되지 않았습니다. 다른 결제 수단으로 다시 시도해 주세요.', en: 'Payment was declined. Try another method.' },
  PAYMENT_CANCELLED: { ko: '결제가 취소되었습니다.', en: 'Payment was cancelled.' },
  PAYMENT_CONFIRMING: { ko: '결제를 확인하는 중입니다. 잠시 후 확인해 주세요.', en: 'Confirming your payment…' },
  NOT_REFUNDABLE: { ko: '환불할 수 없는 상태입니다.', en: 'Not refundable.' },
  REFUND_EXCEEDS_REFUNDABLE: { ko: '환불 가능 금액을 초과했습니다.', en: 'More than the refundable amount.' },
  INVALID_AMOUNT: { ko: '금액을 확인해 주세요.', en: 'Check the amount.' },
  CURRENCY_MISMATCH: { ko: '통화가 일치하지 않습니다.', en: 'Currency mismatch.' },
  SELF_BOOKING: { ko: '내 숙소·상품은 예약할 수 없습니다.', en: 'You cannot book your own listing.' },
  SELF_PURCHASE: { ko: '내 상품은 구매할 수 없습니다.', en: 'You cannot buy your own product.' },
  SELF_REQUEST: { ko: '나에게 요청할 수 없습니다.', en: 'You cannot request yourself.' },
  REVIEW_WINDOW_CLOSED: { ko: '후기 작성 기간이 지났습니다.', en: 'The review window has closed.' },
  REVIEW_EXISTS: { ko: '이미 후기를 작성했습니다.', en: 'You already left a review.' },
  REASON_TOO_SHORT: { ko: '사유를 조금 더 자세히 입력해 주세요.', en: 'Please give a little more detail.' },
  CASE_CLOSED: { ko: '종료된 문의입니다. 새 문의를 접수해 주세요.', en: 'This case is closed. Open a new one.' },
  DISPUTE_CLOSED: { ko: '종료된 분쟁입니다.', en: 'This dispute is closed.' },
  MESSAGE_TOO_LONG: { ko: '메시지가 너무 깁니다.', en: 'The message is too long.' },
  VALIDATION_FAILED: { ko: '입력값을 확인해 주세요.', en: 'Please check your input.' },
  PERMISSION_DENIED: { ko: '이 작업을 수행할 권한이 없습니다.', en: 'You do not have permission for this action.' },
  NOT_IMPLEMENTED: { ko: '아직 준비 중인 기능입니다.', en: 'Not available yet.' },
  INTERNAL: { ko: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', en: 'Something went wrong. Please try again.' },
  INTERNAL_ERROR: { ko: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', en: 'Something went wrong. Please try again.' },
};

/** Per-screen wording for a code, e.g. `{ INVALID_CREDENTIALS: ['현재 비밀번호가 올바르지 않습니다.', 'Current password is incorrect.'] }`. */
export type MessageOverrides = Record<string, readonly [string, string] | { ko: string; en: string }>;

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;

/** Generic HTTP reason phrases are not worth showing; specific server titles are. */
const GENERIC_TITLE = /^(bad request|unprocessable( entity| content)?|conflict|forbidden|not found|unauthorized|internal server error|validation (failed|error)|request validation failed)$/i;

/**
 * User-facing message: mapped code → localized copy. For unmapped codes the server detail/title is used only when
 * it is in the UI language (Korean UI never shows raw English server text); otherwise a status-based Korean
 * fallback is shown. `overrides` lets a screen reword a code (e.g. the password-change form).
 */
export function errorMessage(err: unknown, lang: 'ko' | 'en' = 'ko', overrides?: MessageOverrides): string {
  if (err instanceof ApiError) {
    const o = overrides?.[err.code];
    if (o) return Array.isArray(o) ? o[lang === 'ko' ? 0 : 1] : (o as { ko: string; en: string })[lang];
    const base = err.code.split(':')[0];
    const m = MESSAGES[err.code] ?? MESSAGES[base];
    if (m) return m[lang];
    const fits = (t?: string) => !!t && (lang === 'ko' ? HANGUL.test(t) : true);
    if (fits(err.problem.detail)) return err.problem.detail!;
    if (err.problem.title && fits(err.problem.title) && !GENERIC_TITLE.test(err.problem.title.trim()) && err.code !== 'INVALID_INPUT' && err.code !== 'VALIDATION_FAILED') return err.problem.title;
    const fallback = MESSAGES[defaultCode(err.status)];
    return fallback ? fallback[lang] : err.message;
  }
  if (err instanceof Error) {
    if (lang === 'ko' && !HANGUL.test(err.message)) return MESSAGES.SERVER_ERROR.ko;
    return err.message;
  }
  return String(err);
}

/** Field-level validation errors from a problem+json body: `{ errors: [{ path, message }] }` (zod) → { field: message }. */
export function fieldErrors(err: unknown, lang: 'ko' | 'en' = 'ko'): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const raw = (err.problem.errors ?? (err.problem.details as any)?.errors ?? (err.problem.details as any)?.issues ?? err.problem.details) as unknown;
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const e of raw as any[]) {
    const path = Array.isArray(e?.path) ? e.path.join('.') : String(e?.path ?? e?.field ?? e?.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.').replace(/^body\./, '');
    if (!path) continue;
    const msg = String(e?.message ?? '');
    out[path] = lang === 'ko' && !HANGUL.test(msg) ? '입력값을 확인해 주세요.' : msg || (lang === 'ko' ? '입력값을 확인해 주세요.' : 'Check this field.');
  }
  return out;
}
