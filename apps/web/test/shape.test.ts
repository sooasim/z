import { describe, expect, it } from 'vitest';
import { arr, f, item, items, nextCursor, num, str } from '@/lib/shape';

describe('defensive response parsing', () => {
  it('unwraps item/items envelopes and bare arrays', () => {
    expect(items({ items: [1, 2] })).toEqual([1, 2]);
    expect(items({ data: [3] })).toEqual([3]);
    expect(items([4])).toEqual([4]);
    expect(items({ data: { items: [5] } })).toEqual([5]);
    expect(items(null)).toEqual([]);
    expect(item({ item: { id: 'a' } })).toEqual({ id: 'a' });
    expect(item({ id: 'b' })).toEqual({ id: 'b' });
    expect(nextCursor({ next_cursor: 'c' })).toBe('c');
  });
  it('reads camelCase or snake_case with fallbacks and dotted paths', () => {
    const row = { nightly_price_minor: '120000', host: { display_name: 'Kim' }, tags: ['a'] };
    expect(num(row, 'nightlyPriceMinor')).toBe(120000);
    expect(str(row, 'host.displayName')).toBe('Kim');
    expect(f(row, 'missing', 'nightlyPriceMinor')).toBe('120000');
    expect(arr(row, 'tags')).toEqual(['a']);
    expect(str(row, 'nope')).toBe('');
    expect(num({ v: 'x' }, 'v')).toBeUndefined();
  });
});
