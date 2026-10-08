import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { STATES } from '@/lib/statuses';
import { enumLabel, humanizeEnum } from '@/lib/enums';

/** Every value allowed by a `status`/`state` CHECK constraint in the DB migrations. */
function dbStatusValues(): string[] {
  const dir = path.resolve(__dirname, '../../../packages/db/migrations');
  if (!fs.existsSync(dir)) return [];
  const out = new Set<string>();
  const re = /CHECK\s*\(\s*"?(?:\w+_)?(?:status|state)"?\s+IN\s*\(([^)]*)\)/gi;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of sql.matchAll(re)) for (const v of m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)) out.add(v[1]);
  }
  return [...out].sort();
}

describe('StatusPill dictionary', () => {
  it('has a Korean label for every DB status value', () => {
    const values = dbStatusValues();
    expect(values.length).toBeGreaterThan(20);
    const missing = values.filter((v) => !STATES[v]);
    expect(missing).toEqual([]);
  });
  it('labels are non-empty and Korean labels contain Hangul (or are acronyms)', () => {
    for (const [k, [, ko, en]] of Object.entries(STATES)) {
      expect(ko, k).toBeTruthy();
      expect(en, k).toBeTruthy();
      expect(/[가-힣]/.test(ko) || /^[A-Z]+$/.test(ko), k).toBe(true);
    }
  });
});

describe('enum labels', () => {
  it('localizes known enums and action keys', () => {
    expect(enumLabel('RESERVATION', 'ko')).toBe('숙소 예약');
    expect(enumLabel('auth.login', 'ko')).toBe('로그인');
    expect(enumLabel('GUEST_CANCELLED_POLICY_50', 'ko')).toContain('50%');
    expect(enumLabel('*', 'ko')).toBe('전체');
  });
  it('humanizes unknown enums instead of showing SNAKE_CASE', () => {
    expect(humanizeEnum('SOMETHING_NEW', 'en')).toBe('Something new');
    expect(enumLabel('Free text stays', 'ko')).toBe('Free text stays');
  });
});
