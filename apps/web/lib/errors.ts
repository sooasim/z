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
};

export function errorMessage(err: unknown, lang: 'ko' | 'en' = 'ko'): string {
  if (err instanceof ApiError) {
    const m = MESSAGES[err.code];
    if (m) return m[lang];
    if (err.problem.detail) return err.problem.detail;
    const fallback = MESSAGES[defaultCode(err.status)];
    return fallback ? fallback[lang] : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
