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
  it('uses server detail for unknown codes', () => {
    expect(errorMessage(new ApiError(422, { code: 'WEIRD', detail: 'custom text' }))).toBe('custom text');
    expect(errorMessage(new ApiError(422, { code: 'WEIRD2', title: 'Home A allows at most 4 guests' }))).toBe('Home A allows at most 4 guests');
    expect(errorMessage(new ApiError(422, { code: 'WEIRD3', title: 'Unprocessable Entity' }), 'en')).toBe('Please check your input.');
    expect(errorMessage(new ApiError(422, { code: 'NOT_ELIGIBLE', title: 'x' }), 'ko')).toContain('맞교환 자격');
  });
});
