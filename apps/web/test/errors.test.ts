import { describe, expect, it } from 'vitest';
import { ApiError, classifyError, errorMessage, problemFromResponse } from '@/lib/errors';

describe('API error mapping', () => {
  it('parses RFC 7807 problem+json with code', async () => {
    const res = new Response(JSON.stringify({ type: 'about:blank', title: 'Conflict', status: 409, code: 'INVENTORY_UNAVAILABLE', detail: 'taken' }), { status: 409 });
    const p = await problemFromResponse(res);
    const e = new ApiError(409, p);
    expect(e.code).toBe('INVENTORY_UNAVAILABLE');
    expect(e.kind).toBe('conflict');
    expect(errorMessage(e, 'ko')).toContain('예약할 수 없습니다');
    expect(errorMessage(e, 'en')).toBe('Those dates are no longer available.');
  });
  it('maps AAL2_REQUIRED to the MFA prompt kind', () => {
    expect(classifyError(403, 'AAL2_REQUIRED')).toBe('mfa_required');
    expect(new ApiError(403, { code: 'AAL2_REQUIRED' }).kind).toBe('mfa_required');
  });
  it('maps disabled feature flags', () => {
    expect(classifyError(403, 'FEATURE_DISABLED')).toBe('disabled');
    expect(classifyError(404, 'EXCHANGE_DISABLED')).toBe('disabled');
  });
  it('falls back on status when code missing', () => {
    expect(new ApiError(401, {}).code).toBe('UNAUTHENTICATED');
    expect(new ApiError(404, {}).kind).toBe('not_found');
    expect(new ApiError(0, {}).kind).toBe('network');
    expect(new ApiError(500, {}).kind).toBe('server');
    expect(new ApiError(429, {}).kind).toBe('rate_limited');
  });
  it('handles nested {error:{...}} and non-JSON bodies', async () => {
    const nested = await problemFromResponse(new Response(JSON.stringify({ error: { code: 'X', message: 'y' } }), { status: 400 }));
    expect(nested.code).toBe('X');
    const text = await problemFromResponse(new Response('Bad Gateway', { status: 502 }));
    expect(text.detail).toBe('Bad Gateway');
  });
  it('uses server detail for unknown codes when it is in the UI language', () => {
    expect(errorMessage(new ApiError(422, { code: 'WEIRD', detail: 'custom text' }), 'en')).toBe('custom text');
    expect(errorMessage(new ApiError(422, { code: 'WEIRD2', title: 'Home A allows at most 4 guests' }), 'en')).toBe('Home A allows at most 4 guests');
    expect(errorMessage(new ApiError(422, { code: 'WEIRD4', detail: '숙소 A는 최대 4명까지 가능합니다' }), 'ko')).toBe('숙소 A는 최대 4명까지 가능합니다');
    expect(errorMessage(new ApiError(422, { code: 'WEIRD3', title: 'Unprocessable Entity' }), 'en')).toBe('Please check your input.');
    expect(errorMessage(new ApiError(422, { code: 'NOT_ELIGIBLE', title: 'x' }), 'ko')).toContain('맞교환 자격');
  });
  it('never shows raw English server text in the Korean UI', () => {
    expect(errorMessage(new ApiError(422, { code: 'WEIRD', detail: 'custom text' }), 'ko')).toBe('입력값을 확인해 주세요.');
    expect(errorMessage(new ApiError(500, { title: 'Internal' }), 'ko')).toBe('일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    expect(errorMessage(new ApiError(403, { code: 'GUIDE_REQUIRED', detail: 'Only published guides can browse open requests' }), 'ko')).toContain('가이드 프로필');
    expect(errorMessage(new ApiError(409, { code: 'EMAIL_TAKEN', detail: 'An account with this email already exists' }), 'ko')).toContain('이미 가입된 이메일');
    expect(errorMessage(new ApiError(400, { code: 'MFA_CODE_INVALID' }), 'ko')).toContain('인증 코드');
  });
  it('supports per-screen overrides', () => {
    const e = new ApiError(401, { code: 'INVALID_CREDENTIALS' });
    expect(errorMessage(e, 'ko', { INVALID_CREDENTIALS: ['현재 비밀번호가 올바르지 않습니다.', 'Current password is incorrect.'] })).toBe('현재 비밀번호가 올바르지 않습니다.');
  });
});
