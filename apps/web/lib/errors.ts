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
  SERVER_ERROR: { ko: '일시적인 오류가 발생했습니다.', en: 'Something went wrong.' },
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
};

/** Generic HTTP reason phrases are not worth showing; specific server titles are. */
const GENERIC_TITLE = /^(bad request|unprocessable( entity| content)?|conflict|forbidden|not found|unauthorized|internal server error|validation (failed|error)|request validation failed)$/i;

export function errorMessage(err: unknown, lang: 'ko' | 'en' = 'ko'): string {
  if (err instanceof ApiError) {
    const m = MESSAGES[err.code];
    if (m) return m[lang];
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title && !GENERIC_TITLE.test(err.problem.title.trim()) && err.code !== 'INVALID_INPUT' && err.code !== 'VALIDATION_FAILED') return err.problem.title;
    const fallback = MESSAGES[defaultCode(err.status)];
    return fallback ? fallback[lang] : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
