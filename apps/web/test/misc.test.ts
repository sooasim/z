import { describe, expect, it } from 'vitest';
import { SseParser } from '@/lib/sse';
import { isKnownPath, parseRedirect } from '@/lib/routes';
import { paymentPhase, parsePrepare, subjectHref } from '@/lib/payment';
import { buildUrl } from '@/lib/api';
import { postcardFor, flagFor, hashString } from '@/lib/art';
import { validateUpload } from '@/lib/media';
import { quoteView } from '@/lib/quote';

describe('SSE parser', () => {
  it('parses events split across chunks', () => {
    const p = new SseParser();
    expect(p.push('event: message\ndata: {"a":')).toEqual([]);
    const out = p.push('1}\nid: 7\n\n: keepalive\n\ndata: x\ndata: y\n\n');
    expect(out).toEqual([
      { event: 'message', data: '{"a":1}', id: '7' },
      { event: 'message', data: 'x\ny', id: undefined },
    ]);
  });
});

describe('legacy redirects', () => {
  it('only looks up unknown paths', () => {
    expect(isKnownPath('/stay/abc')).toBe(true);
    expect(isKnownPath('/')).toBe(true);
    expect(isKnownPath('/favicon.ico')).toBe(true);
    expect(isKnownPath('/shop_view/?idx=12')).toBe(false);
  });
  it('accepts several payload shapes and rejects open redirects to non-http schemes', () => {
    expect(parseRedirect({ item: { toPath: '/travel/1', statusCode: 308 } })).toEqual({ to: '/travel/1', status: 308 });
    expect(parseRedirect({ to: '/x' })).toEqual({ to: '/x', status: 301 });
    expect(parseRedirect({ to: 'javascript:alert(1)' })).toBeNull();
    expect(parseRedirect({})).toBeNull();
  });
});

describe('payments', () => {
  it('normalises prepare responses', () => {
    const p = parsePrepare({ item: { orderId: 'o1', amountMinor: 50000, clientKey: 'test_ck', customerKey: 'c' } });
    expect(p).toMatchObject({ orderId: 'o1', amount: 50000, provider: 'TOSS', currency: 'KRW' });
    expect(parsePrepare({ orderId: 'o2', amount: 1 }).provider).toBe('MOCK');
  });
  it('never treats an unknown status as approved', () => {
    expect(paymentPhase({ item: { status: 'APPROVED' } })).toBe('approved');
    expect(paymentPhase({ status: 'DONE' })).toBe('approved');
    expect(paymentPhase({ status: 'WAITING_FOR_DEPOSIT' })).toBe('pending');
    expect(paymentPhase({})).toBe('pending');
    expect(paymentPhase({ status: 'ABORTED' })).toBe('failed');
  });
  it('links subjects', () => {
    expect(subjectHref('RESERVATION', 'r')).toBe('/trips/r');
    expect(subjectHref('GUIDE_BOOKING', 'g')).toBe('/guide-bookings/g');
    expect(subjectHref('ORDER', 'o')).toBe('/orders/o');
  });
});

describe('misc helpers', () => {
  it('builds URLs with repeated params and skips empties', () => {
    expect(buildUrl('/v1/x', { a: '1', b: '', c: ['p', 'q'], d: undefined }, 'http://api')).toBe('http://api/v1/x?a=1&c=p&c=q');
  });
  it('picks city postcards deterministically', () => {
    expect(postcardFor('제주시 애월읍')).toBe('/art/postcards/jeju.svg');
    expect(postcardFor('Busan')).toBe('/art/postcards/busan.svg');
    expect(postcardFor('Nowhere', 'seed')).toBe(postcardFor('Nowhere', 'seed'));
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(flagFor('ko-KR')).toBe('🇰🇷');
    expect(flagFor('xx')).toBe('🌐');
  });
  it('validates uploads', () => {
    expect(validateUpload({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validateUpload({ type: 'application/x-msdownload', size: 1000 })).toBe('UNSUPPORTED_TYPE');
    expect(validateUpload({ type: 'image/png', size: 99 * 1024 * 1024 })).toBe('FILE_TOO_LARGE');
  });
  it('sums quote lines when total missing', () => {
    const q = quoteView({ item: { id: 'q', lines: [{ code: 'NIGHTLY', amountMinor: 100000 }, { code: 'SERVICE_FEE', amount_minor: 12000 }] } });
    expect(q.totalMinor).toBe(112000);
    expect(q.lines[1].amountMinor).toBe(12000);
  });
});
