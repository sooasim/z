import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, existsSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createTestApp, createUser, type TestApp } from './helpers.js';
import { reconcile, renderReconcileMarkdown, runImport, type Entity } from '../src/modules/integrations/migration/importers.js';
import { buildUrlInventory, classifyPasswordHash, htmlToMarkdown, normalizeEmail, normalizePhone, parseCsv } from '../src/modules/integrations/migration/parse.js';
import { verifyPassword } from '../src/platform/crypto.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy');
const read = (f: string) => readFileSync(path.join(FIX, f), 'utf8');
let t: TestApp;

const run = (entity: Entity, file: string, mode: 'DRY_RUN' | 'APPLY', extra: Record<string, unknown> = {}) =>
  runImport(t.pool, entity, { source: 'SIXSHOP', mode, fileName: file, content: read(file), mediaDir: path.join(FIX, 'media'), ...extra });

beforeAll(async () => {
  t = await createTestApp();
  await createUser(t, { email: 'existing@jetpool.kr' });
});
afterAll(async () => t.close());

describe('MIG-01 pure helpers', () => {
  it('parses quoted CSV and normalises contacts', () => {
    const rows = parseCsv('a,b\r\n"x,1","he said ""hi"""\n"multi\nline",2\n');
    expect(rows).toEqual([{ a: 'x,1', b: 'he said "hi"' }, { a: 'multi\nline', b: '2' }]);
    expect(normalizeEmail(' Minji.Kim@Example.com ')).toBe('minji.kim@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizePhone('010-1234-5678')).toBe('+821012345678');
    expect(normalizePhone('+82 10 9876 5432')).toBe('+821098765432');
    expect(normalizePhone('02-123-4567')).toBe('+8221234567');
    expect(classifyPasswordHash('$2y$10$abc', null)).toBe('BCRYPT');
    expect(classifyPasswordHash('5f4dcc3b5aa765d61d8327deb882cf99', null)).toBe('MD5');
    expect(classifyPasswordHash('scrypt$16384$8$1$c2FsdA$aGFzaA', null)).toBe('SCRYPT_COMPATIBLE');
  });
  it('converts legacy HTML safely and builds a deduplicated URL inventory', () => {
    const h = htmlToMarkdown('<p>Hi</p><script>alert(1)</script><img src="https://x/a.jpg"><a href="javascript:x()">bad</a><a href="/ok">ok</a>');
    expect(h.markdown).not.toContain('script');
    expect(h.markdown).not.toContain('javascript');
    expect(h.markdown).toContain('![](https://x/a.jpg)');
    expect(h.markdown).toContain('[ok](/ok)');
    expect(h.images).toEqual(['https://x/a.jpg']);
    const inv = buildUrlInventory(read('sitemap.xml'));
    expect(inv.sourceKind).toBe('sitemap');
    expect(inv.items.map((i) => i.path)).toEqual(['/', '/shop/item/12', '/about', '/board/story/1', '/board/faq/2', '/charter']);
    expect(inv.items.every((i) => /^[0-9a-f]{64}$/.test(i.hash))).toBe(true);
  });
});

describe('MIG-01 dry run vs apply', () => {
  it('dry run validates and audits but writes no domain rows', async () => {
    const before = await t.pool.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM cms_entries)::int AS cms, (SELECT count(*) FROM media_assets)::int AS media, (SELECT count(*) FROM seo_redirects)::int AS redirects`);
    const m = await run('members', 'members.csv', 'DRY_RUN');
    expect(m).toMatchObject({ mode: 'DRY_RUN', sourceCount: 6, imported: 3, skipped: 2, errors: 1 });
    expect(m.report.stats).toMatchObject({ passwordResetRequired: 2, consentRecords: 3 });
    const c = await run('content', 'content.csv', 'DRY_RUN');
    expect(c).toMatchObject({ imported: 2, errors: 1 });
    const md = await run('media', 'media.csv', 'DRY_RUN');
    expect(md).toMatchObject({ imported: 1, errors: 3 });
    expect(md.report.outcomes).toMatchObject({ CHECKSUM_MISMATCH: 1, MISSING_FILE: 1, PATH_TRAVERSAL: 1 });
    const r = await run('redirects', 'redirects.csv', 'DRY_RUN');
    expect(r).toMatchObject({ imported: 2, skipped: 1, errors: 1 });
    const after = await t.pool.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM cms_entries)::int AS cms, (SELECT count(*) FROM media_assets)::int AS media, (SELECT count(*) FROM seo_redirects)::int AS redirects`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM migration_id_map`)).rows[0].n).toBe(0);
    const audit = await t.pool.query(`SELECT count(*)::int AS n FROM migration_audit WHERE batch_id = $1`, [m.batchId]);
    expect(audit.rows[0].n).toBe(6);
    const b = await t.pool.query(`SELECT status, source_file_hash FROM migration_batches WHERE id = $1`, [m.batchId]);
    expect(b.rows[0].status).toBe('SUCCEEDED');
    expect(b.rows[0].source_file_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('apply imports members safely: no takeover, passwords reset unless compatible, consent evidence kept', async () => {
    const m = await run('members', 'members.csv', 'APPLY');
    expect(m).toMatchObject({ mode: 'APPLY', imported: 3, skipped: 2, errors: 1 });
    const users = await t.pool.query(
      `SELECT u.email, u.phone, u.password_hash, f.requires_password_reset, f.legacy_password_format
         FROM migration_user_flags f JOIN users u ON u.id = f.user_id ORDER BY f.legacy_id`,
    );
    expect(users.rows.map((r) => r.email)).toEqual(['minji.kim@example.com', 'jun@example.com', 'lee,"quoted"@example.com']);
    expect(users.rows[0]).toMatchObject({ phone: '+821012345678', password_hash: null, requires_password_reset: true, legacy_password_format: 'BCRYPT' });
    expect(users.rows[1]).toMatchObject({ password_hash: null, requires_password_reset: true, legacy_password_format: 'MD5' });
    expect(users.rows[2].requires_password_reset).toBe(false);
    expect(users.rows[2].password_hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('anything', users.rows[0].password_hash)).toBe(false);
    const existing = await t.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'existing@jetpool.kr'`);
    expect(existing.rows[0].n).toBe(1);
    const consent = await t.pool.query(`SELECT granted, evidence FROM consent_records WHERE version = 'legacy-sixshop' ORDER BY evidence->>'legacyId'`);
    expect(consent.rows.map((r) => r.granted)).toEqual([true, false, true]);
    expect(consent.rows[0].evidence).toMatchObject({ source: 'SIXSHOP', legacyId: '1001', legacyValue: 'Y', sourceFile: 'members.csv' });
    expect(consent.rows[0].evidence.sourceFileSha256).toBe(m.sourceFileHash);
    // re-apply is idempotent
    const again = await run('members', 'members.csv', 'APPLY');
    expect(again).toMatchObject({ imported: 0 });
    expect(again.report.outcomes).toMatchObject({ ALREADY_IMPORTED: 3 });
  });

  it('apply imports content (draft), media (checksummed) and redirects (unapproved)', async () => {
    const c = await run('content', 'content.csv', 'APPLY');
    expect(c.imported).toBe(2);
    const e = await t.pool.query(`SELECT entry_type, slug, status, body_md, data FROM cms_entries ORDER BY slug`);
    expect(e.rows.map((r) => [r.entry_type, r.slug, r.status])).toEqual([
      ['STORY', 'jeju-month', 'DRAFT'],
      ['FAQ', 'legacy-p2', 'DRAFT'],
    ]);
    expect(e.rows[0].body_md).not.toContain('<script');
    const md = await run('media', 'media.csv', 'APPLY', { cdnBaseUrl: 'https://cdn.jetpool.kr' });
    expect(md.imported).toBe(1);
    const asset = await t.pool.query(`SELECT storage_key, sha256, byte_size, public_url FROM media_assets`);
    expect(asset.rows).toHaveLength(1);
    expect(asset.rows[0].storage_key).toBe(`legacy/sixshop/${asset.rows[0].sha256}.jpg`);
    expect(asset.rows[0].public_url).toContain('https://cdn.jetpool.kr/legacy/sixshop/');
    const r = await run('redirects', 'redirects.csv', 'APPLY');
    expect(r).toMatchObject({ imported: 2, skipped: 1, errors: 1 });
    const red = await t.pool.query(`SELECT legacy_path, target_path, approved FROM seo_redirects ORDER BY legacy_path`);
    expect(red.rows).toEqual([
      { legacy_path: '/about', target_path: '/p/about', approved: false },
      { legacy_path: '/board/faq/2', target_path: '/faq/legacy-p2', approved: false },
      { legacy_path: '/board/story/1', target_path: '/stories/jeju-month', approved: false },
      { legacy_path: '/shop/item/12', target_path: '/stay/seoul-hanok', approved: false },
    ]);
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'migration.batch.completed'`);
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(9);
  });

  it('reconciliation proves counts, media references, URL mappings and amounts', async () => {
    const rep = await reconcile(t.pool, { source: 'SIXSHOP', inventoryText: read('sitemap.xml'), ordersText: read('orders.csv') });
    expect(rep.entities.members.APPLY).toMatchObject({ sourceCount: 6, balanced: true });
    expect(rep.members).toEqual({ imported: 3, passwordResetRequired: 2, consentRecords: 3 });
    expect(rep.idMap.member).toBe(3);
    expect(rep.media).toEqual({ referenced: 1, resolved: 1, broken: [] });
    expect(rep.urls).toMatchObject({ total: 6, mappedApproved: 0, mappedPendingApproval: 4, unmapped: 1, unmappedSample: ['/charter'] });
    expect(rep.amounts.byCurrency.KRW).toEqual({ orders: 2, amountMinor: 235000 });
    expect(rep.amounts.invalidRows).toEqual(['o3']);
    expect(rep.readyForCutover).toBe(false);
    const failing = rep.checks.filter((c) => !c.pass).map((c) => c.check);
    expect(failing).toEqual(expect.arrayContaining(['members.batch_balanced_no_errors', 'urls.all_inventory_urls_mapped', 'urls.all_mappings_approved', 'orders.no_invalid_amounts']));
    const md = renderReconcileMarkdown(rep);
    expect(md).toContain('**Ready for cutover:** NO');
    expect(md).toContain('/charter');
  });

  it('CLI: inventory and dry-run import run end-to-end', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'jp-mig-'));
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/migrate-legacy.ts');
    // The `.bin/tsx` shim is an extension-less shell script that Node cannot spawn on Windows; run tsx's own
    // entrypoint with the current `node` instead (what the shim does on POSIX).
    const tsxPkg = createRequire(import.meta.url).resolve('tsx/package.json');
    const tsx = [path.resolve(path.dirname(tsxPkg), JSON.parse(rf(tsxPkg, 'utf8')).bin as string), cli];
    execFileSync(process.execPath, [...tsx, 'inventory', '--file', path.join(FIX, 'sitemap.xml'), '--out', path.join(out, 'inv.json')], { encoding: 'utf8' });
    expect(JSON.parse(rf(path.join(out, 'inv.json'), 'utf8')).count).toBe(6);
    const dbUrl = (t.app.ctx.config.DATABASE_URL);
    const res = spawnSync(process.execPath, [...tsx, 'import-redirects', '--file', path.join(FIX, 'redirects.csv')], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: dbUrl } });
    expect(res.status).toBe(1); // the fixture contains an unsafe target → non-zero exit for CI gating
    expect(JSON.parse(res.stdout.slice(res.stdout.indexOf('{')))).toMatchObject({ mode: 'DRY_RUN', sourceCount: 4, errors: 1 });
    try {
      execFileSync(process.execPath, [...tsx, 'reconcile', '--inventory', path.join(FIX, 'sitemap.xml'), '--out', path.join(out, 'rep')], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: dbUrl } });
    } catch (e: any) {
      expect(e.status).toBe(1); // not ready for cutover
    }
    expect(existsSync(path.join(out, 'rep.md'))).toBe(true);
    expect(existsSync(path.join(out, 'rep.json'))).toBe(true);
  }, 60_000);
});
