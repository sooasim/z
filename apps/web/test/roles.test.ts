import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_GUIDES, ROLE_SLUGS, roleByDemoKey, roleBySlug } from '@/lib/roles';

/**
 * The role guide (`/help/<slug>`) is hand-written copy about screens and accounts that live elsewhere, so the
 * two ways it can rot are a route that no longer exists and a demo account the API never offers. Both are
 * checked here against the real files rather than against another copy of the list.
 */
const WEB_ROOT = path.resolve(__dirname, '..');
const API_DEMO = path.resolve(WEB_ROOT, '../api/src/modules/identity/demo-accounts.ts');

/** Every route segment the app ships, as directory names under app/. */
function routeExists(href: string): boolean {
  const segments = href.split('?')[0].split('#')[0].split('/').filter(Boolean);
  let dir = path.join(WEB_ROOT, 'app');
  for (const seg of segments) {
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    // a `[param]` segment in the guide matches the app's dynamic directory, whatever it is named
    const hit = seg.startsWith('[') ? entries.find((e) => e.startsWith('[')) : entries.find((e) => e === seg);
    if (!hit) return false;
    dir = path.join(dir, hit);
  }
  return fs.existsSync(path.join(dir, 'page.tsx'));
}

describe('role guide', () => {
  it('has a unique slug per role and finds them all back', () => {
    expect(new Set(ROLE_SLUGS).size).toBe(ROLE_GUIDES.length);
    for (const g of ROLE_GUIDES) expect(roleBySlug(g.slug)).toBe(g);
    expect(roleBySlug('not-a-role')).toBeUndefined();
  });

  it('only points at routes this app actually has', () => {
    const missing: string[] = [];
    for (const g of ROLE_GUIDES) for (const s of g.screens) if (!routeExists(s.href)) missing.push(`${g.slug}: ${s.href}`);
    expect(missing).toEqual([]);
  });

  it('only offers demo accounts the API registry defines, and claims each one once', () => {
    const api = fs.readFileSync(API_DEMO, 'utf8');
    const known = [...api.matchAll(/\{ key: '([a-z-]+)', email:/g)].map((m) => m[1]);
    expect(known.length).toBeGreaterThan(0);
    const claimed = ROLE_GUIDES.flatMap((g) => g.demoKeys);
    expect(claimed.filter((k) => !known.includes(k))).toEqual([]);
    expect(new Set(claimed).size).toBe(claimed.length);
    // every seeded account leads somewhere: a login button with no guide behind it is a dead end
    expect(known.filter((k) => !roleByDemoKey(k))).toEqual([]);
  });

  it('writes both languages for every piece of copy', () => {
    const pairs: Array<readonly [string, string]> = [];
    for (const g of ROLE_GUIDES) {
      pairs.push(g.name, g.tagline, g.intro, ...g.steps, ...(g.notes ?? []));
      for (const s of g.screens) pairs.push(s.name, s.what, ...(s.actions ?? []));
    }
    const bad = pairs.filter((p) => p.length !== 2 || !p[0]?.trim() || !p[1]?.trim());
    expect(bad).toEqual([]);
  });

  it('lands each role on one of its own screens', () => {
    for (const g of ROLE_GUIDES) {
      expect(routeExists(g.home), `${g.slug} home ${g.home}`).toBe(true);
      expect(g.screens.some((s) => s.href === g.home || g.home.startsWith(s.href))).toBe(true);
    }
  });
});
