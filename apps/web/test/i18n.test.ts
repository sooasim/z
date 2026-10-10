import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DICT, type DictKey } from '@/lib/dict';
import { LANGS, isLang, langInfo, pickLang } from '@/lib/langs';
import { PHRASES, SAME_AS_ENGLISH, pickText, translate } from '@/lib/phrases';
import { formatMoney, formatRange, intlLocale, nightsText, type Lang } from '@/lib/format';
import { statusLabel } from '@/components/ui/status';

const CODES = LANGS.map((l) => l.code);

function webSource(): string {
  const root = path.resolve(__dirname, '..');
  let out = '';
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'test') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name)) out += fs.readFileSync(f, 'utf8');
    }
  };
  walk(root);
  return out;
}

describe('language registry', () => {
  it('ships Korean, English, Japanese, Chinese and Vietnamese with distinct codes and locales', () => {
    expect(CODES).toEqual(['ko', 'en', 'ja', 'zh', 'vi']);
    expect(new Set(LANGS.map((l) => l.locale)).size).toBe(LANGS.length);
    for (const l of LANGS) {
      expect(l.endonym, l.code).toBeTruthy();
      expect(l.english, l.code).toBeTruthy();
      // the locale must be one Intl actually understands, or every formatter silently falls back
      expect(() => new Intl.DateTimeFormat(l.locale).format(new Date()), l.locale).not.toThrow();
      expect(Intl.DateTimeFormat.supportedLocalesOf([l.locale]), l.locale).toHaveLength(1);
    }
  });

  it('isLang accepts exactly the shipped codes', () => {
    for (const c of CODES) expect(isLang(c), c).toBe(true);
    for (const c of ['de', 'KO', '', null, undefined, 'ko-KR']) expect(isLang(c), String(c)).toBe(false);
  });

  it('matches a browser language list on the primary subtag, and reports no match rather than guessing', () => {
    expect(pickLang(['ja-JP', 'en-US'])).toBe('ja');
    expect(pickLang(['en-GB'])).toBe('en');
    expect(pickLang(['zh-Hant-TW'])).toBe('zh'); // Traditional readers get Simplified, not English
    expect(pickLang(['vi'])).toBe('vi');
    expect(pickLang(['de-DE', 'fr'])).toBeNull();
    expect(pickLang([])).toBeNull();
    expect(pickLang(undefined)).toBeNull();
    // first supported tag wins, even when an unsupported one is more preferred
    expect(pickLang(['de', 'ja', 'en'])).toBe('ja');
  });
});

describe('dictionary', () => {
  it('has every chrome key in every language, non-empty', () => {
    const keys = Object.keys(DICT.ko) as DictKey[];
    expect(keys.length).toBeGreaterThan(30);
    for (const code of CODES) {
      for (const k of keys) {
        expect(DICT[code][k], `${code}/${k}`).toBeTruthy();
      }
      expect(Object.keys(DICT[code]).sort(), code).toEqual([...keys].sort());
    }
  });

  it('translates the chrome rather than copying English through', () => {
    // Vietnamese writes "Menu" as the English loanword; nothing else may match English by accident.
    const expected: Partial<Record<Lang, string[]>> = { vi: ['nav.menu'] };
    for (const code of CODES.filter((c) => c !== 'en')) {
      const same = (Object.keys(DICT.ko) as DictKey[]).filter((k) => DICT[code][k] === DICT.en[k]);
      expect(same, code).toEqual(expected[code] ?? []);
    }
  });
});

describe('phrase table', () => {
  it('covers the same source strings in every translated language', () => {
    const langs = Object.keys(PHRASES) as Array<keyof typeof PHRASES>;
    expect(langs.sort()).toEqual(['ja', 'vi', 'zh']);
    const base = Object.keys(PHRASES.ja).sort();
    expect(base.length).toBeGreaterThan(100);
    for (const l of langs) expect(Object.keys(PHRASES[l]).sort(), l).toEqual(base);
  });

  it('never leaves a translation empty, and only the declared loanwords match their English source', () => {
    for (const [l, table] of Object.entries(PHRASES)) {
      const allowed = SAME_AS_ENGLISH[l as keyof typeof SAME_AS_ENGLISH];
      const identical: string[] = [];
      for (const [source, value] of Object.entries(table)) {
        expect(value, `${l}: ${source}`).toBeTruthy();
        if (value === source) identical.push(source);
      }
      expect(identical.sort(), l).toEqual([...allowed].sort());
    }
  });

  it('only holds strings the screens actually pass to L(), so the table cannot rot', () => {
    const src = webSource();
    const stale = Object.keys(PHRASES.ja).filter((k) => !src.includes(`'${k}'`));
    expect(stale).toEqual([]);
  });

  it('falls back to the English source for ko/en and for untranslated phrases', () => {
    expect(translate('Search', 'ko')).toBe('Search');
    expect(translate('Search', 'en')).toBe('Search');
    expect(translate('Search', 'ja')).toBe('検索');
    expect(translate('a phrase nobody translated yet', 'vi')).toBe('a phrase nobody translated yet');
  });

  it('pickText reads ko directly and routes every other language through the table', () => {
    const rec = { ko: '검색', en: 'Search' };
    expect(pickText(rec, 'ko')).toBe('검색');
    expect(pickText(rec, 'en')).toBe('Search');
    expect(pickText(rec, 'zh')).toBe('搜索');
    expect(pickText({ ko: '', en: 'Only English' }, 'ko')).toBe('Only English');
  });
});

describe('formatters follow the language', () => {
  it('maps every language to its Intl locale', () => {
    for (const l of LANGS) expect(intlLocale(l.code), l.code).toBe(l.locale);
  });

  it('formats KRW per language without ever losing the amount', () => {
    for (const code of CODES) {
      const s = formatMoney(240_000, 'KRW', code);
      expect(s, code).toMatch(/240[,.\s]?000/);
    }
  });

  it('writes night counts in the right language', () => {
    expect(nightsText(3, 'ko')).toBe('3박');
    expect(nightsText(3, 'ja')).toBe('3泊');
    expect(nightsText(3, 'zh')).toBe('3晚');
    expect(nightsText(3, 'vi')).toBe('3 đêm');
    expect(nightsText(1, 'en')).toBe('1 night');
    expect(nightsText(3, 'en')).toBe('3 nights');
  });

  it('formats a date range in each language, with the night count appended', () => {
    for (const code of CODES) {
      const s = formatRange('2026-11-10', '2026-11-13', code, { nights: true });
      expect(s, code).toContain('·');
      expect(s, code).toContain(nightsText(3, code));
      expect(s, code).not.toContain('Invalid');
    }
    expect(formatRange('2026-11-10', '2026-11-13', 'ja')).toMatch(/11月10日/);
    expect(formatRange('2026-11-10', '2026-11-13', 'zh')).toMatch(/11月10日/);
  });
});

describe('status labels', () => {
  it('render Korean, English and the translated languages', () => {
    expect(statusLabel('CONFIRMED', 'ko')).toBe('확정');
    expect(statusLabel('CONFIRMED', 'en')).toBe('Confirmed');
    expect(statusLabel('CONFIRMED', 'ja')).toBe('確定');
    expect(statusLabel('CONFIRMED', 'zh')).toBe('已确认');
    expect(statusLabel('CONFIRMED', 'vi')).toBe('Đã xác nhận');
  });

  it('keeps per-perspective overrides working in every language', () => {
    const labels = { OFFERED: ['제안 보냄', 'Offer sent'] as [string, string] };
    expect(statusLabel('OFFERED', 'ko', labels)).toBe('제안 보냄');
    expect(statusLabel('OFFERED', 'ja', labels)).toBe('Offer sent'); // not translated yet → English
  });

  it('never shows a raw enum, in any language', () => {
    for (const code of CODES) {
      const s = statusLabel('SOME_UNKNOWN_STATE', code as Lang);
      expect(s, code).not.toContain('_');
      expect(s, code).toBeTruthy();
    }
  });

  it('langInfo falls back to Korean for an unknown code', () => {
    expect(langInfo('ko').locale).toBe('ko-KR');
    expect(langInfo('xx' as Lang).code).toBe('ko');
  });
});
