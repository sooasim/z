import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { Db, Tx } from '../../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../../platform/db.js';
import type { AppContext, Ctx } from '../../../platform/context.js';
import { emit } from '../../../platform/outbox.js';
import { assertSafeTarget, normalizePath, upsertRedirects, ENTRY_PATHS, type EntryType } from '../../cms/service.js';
import {
  classifyPasswordHash,
  htmlToMarkdown,
  normalizeEmail,
  normalizePhone,
  parseBoolConsent,
  parseCsv,
  parseLegacyDate,
  pick,
  sha256Hex,
  slugify,
  buildUrlInventory,
} from './parse.js';

/**
 * MIG-01 legacy WONT/Sixshop importers. DRY_RUN (default) validates every row, records the batch and per-row
 * audit, but performs NO domain writes; APPLY writes domain rows + migration_id_map. Re-running APPLY is
 * idempotent (rows already in migration_id_map are SKIPPED). Legacy passwords are never stored unless the
 * hash format is verifiable by the platform (scrypt); everyone else is flagged for password reset.
 */

export type Mode = 'DRY_RUN' | 'APPLY';
export type Entity = 'members' | 'content' | 'media' | 'redirects';
export const LEGACY_TYPE: Record<Entity, string> = { members: 'member', content: 'content', media: 'media', redirects: 'redirect' };

export interface ImportOptions {
  source: string; // 'SIXSHOP' | 'WONT'
  mode: Mode;
  fileName: string;
  content: string;
  /** media: directory holding the exported files */
  mediaDir?: string;
  /** media: optional uploader (e.g. S3 put via the media module's storage adapter) */
  uploader?: (key: string, bytes: Buffer, mime: string) => Promise<void>;
  cdnBaseUrl?: string;
  /** content: publish immediately (default: DRAFT for editorial review) */
  publish?: boolean;
  /** redirects: mark approved (requires business sign-off) */
  approve?: boolean;
  /** the human running the CLI (recorded in audit actor) */
  operatorId?: string | null;
}

export interface BatchResult {
  batchId: string;
  entity: Entity;
  mode: Mode;
  source: string;
  sourceFileHash: string;
  sourceCount: number;
  imported: number;
  skipped: number;
  errors: number;
  report: Record<string, unknown>;
}

interface RowOutcome { legacyId: string | null; outcome: 'IMPORTED' | 'SKIPPED' | 'ERROR'; message?: string }

/** Minimal Ctx for CLI / jobs (no HTTP request). */
export function migrationCtx(correlationId: string, app?: AppContext): Ctx {
  return { app: (app ?? ({} as AppContext)), actor: null, correlationId };
}

async function alreadyMapped(db: Db, legacyType: string, legacyId: string) {
  return maybeOne<{ new_id: string }>(db, `SELECT new_id FROM migration_id_map WHERE legacy_type = $1 AND legacy_id = $2`, [legacyType, legacyId]);
}
async function mapId(db: Db, legacyType: string, legacyId: string, newId: string, batchId: string) {
  await db.query(`INSERT INTO migration_id_map(legacy_type, legacy_id, new_id, batch_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [legacyType, legacyId, newId, batchId]);
}

/** Run one row inside a savepoint so a failing row never aborts the batch. */
async function guarded(tx: Tx, fn: () => Promise<RowOutcome>, legacyId: string | null): Promise<RowOutcome> {
  await tx.query('SAVEPOINT mig_row');
  try {
    const r = await fn();
    await tx.query('RELEASE SAVEPOINT mig_row');
    return r;
  } catch (err: any) {
    await tx.query('ROLLBACK TO SAVEPOINT mig_row');
    return { legacyId, outcome: 'ERROR', message: String(err?.code ?? err?.message ?? err).slice(0, 300) };
  }
}

// ---------------------------------------------------------------- members

async function importMember(tx: Tx, ctx: Ctx, o: ImportOptions, batchId: string, fileHash: string, row: Record<string, string>, seenEmails: Set<string>, stats: Record<string, number>): Promise<RowOutcome> {
  const legacyId = pick(row, ['member_id', 'legacy_id', 'id', '회원번호', '회원ID']);
  if (!legacyId) return { legacyId: null, outcome: 'ERROR', message: 'MISSING_LEGACY_ID' };
  if (await alreadyMapped(tx, 'member', legacyId)) return { legacyId, outcome: 'SKIPPED', message: 'ALREADY_IMPORTED' };
  const email = normalizeEmail(pick(row, ['email', '이메일', 'e-mail']));
  if (!email) return { legacyId, outcome: 'ERROR', message: 'INVALID_EMAIL' };
  if (seenEmails.has(email)) return { legacyId, outcome: 'SKIPPED', message: 'DUPLICATE_EMAIL_IN_FILE' };
  seenEmails.add(email);
  const existing = await maybeOne(tx, `SELECT id FROM users WHERE email = $1`, [email]);
  // never auto-link to an existing JETPOOL account (account-takeover risk): manual review
  if (existing) return { legacyId, outcome: 'SKIPPED', message: 'EMAIL_EXISTS_MANUAL_REVIEW' };
  const rawPhone = pick(row, ['phone', 'mobile', '휴대폰', '휴대폰번호', '전화번호']);
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) stats.phoneUnparseable++;
  const fmt = classifyPasswordHash(pick(row, ['password_hash', 'password']), pick(row, ['password_format', 'hash_algo']));
  const compatible = fmt === 'SCRYPT_COMPATIBLE';
  if (!compatible) stats.passwordResetRequired++;
  const consent = parseBoolConsent(pick(row, ['marketing_agree', 'marketing', '마케팅수신동의', '마케팅동의', 'email_agree', 'sms_agree']));
  if (consent !== null) stats.consentRecords++;
  if (o.mode === 'DRY_RUN') return { legacyId, outcome: 'IMPORTED', message: compatible ? 'WOULD_IMPORT' : 'WOULD_IMPORT_RESET_REQUIRED' };

  const joined = parseLegacyDate(pick(row, ['joined_at', 'created_at', '가입일', 'join_date']));
  const name = pick(row, ['name', '이름', 'nickname', 'display_name']);
  const u = await one<{ id: string }>(
    tx,
    `INSERT INTO users(email, phone, password_hash, display_name, status, created_at) VALUES ($1,$2,$3,$4,'ACTIVE', coalesce($5, now())) RETURNING id`,
    [email, phone, compatible ? pick(row, ['password_hash', 'password']) : null, name?.slice(0, 100) ?? null, joined],
  );
  await tx.query(
    `INSERT INTO migration_user_flags(user_id, source, legacy_id, requires_password_reset, legacy_password_format, batch_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [u.id, o.source, legacyId, !compatible, fmt, batchId],
  );
  if (consent !== null) {
    const agreedAt = pick(row, ['marketing_agreed_at', '동의일시', 'consent_at']);
    await tx.query(
      `INSERT INTO consent_records(user_id, consent_type, version, granted, evidence) VALUES ($1,'MARKETING',$2,$3,$4)`,
      [u.id, `legacy-${o.source.toLowerCase()}`, consent, JSON.stringify({ source: o.source, legacyId, legacyValue: pick(row, ['marketing_agree', 'marketing', '마케팅수신동의', '마케팅동의', 'email_agree', 'sms_agree']), legacyAgreedAt: agreedAt, sourceFile: o.fileName, sourceFileSha256: fileHash, batchId })],
    );
    await tx.query(`INSERT INTO user_preferences(user_id, marketing_opt_in) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [u.id, consent]);
  }
  await mapId(tx, 'member', legacyId, u.id, batchId);
  return { legacyId, outcome: 'IMPORTED' };
}

// ---------------------------------------------------------------- content

function contentType(board: string | null): EntryType {
  const b = (board ?? '').toLowerCase();
  if (/faq|자주/.test(b)) return 'FAQ';
  if (/story|blog|magazine|매거진|스토리/.test(b)) return 'STORY';
  if (/destination|여행지/.test(b)) return 'DESTINATION';
  if (/promotion|event|이벤트|프로모션/.test(b)) return 'PROMOTION';
  return 'LEGACY_CONTENT';
}

async function importContent(tx: Tx, ctx: Ctx, o: ImportOptions, batchId: string, row: Record<string, string>, stats: Record<string, number>): Promise<RowOutcome> {
  const legacyId = pick(row, ['post_id', 'legacy_id', 'id', '게시물번호']);
  const title = pick(row, ['title', '제목']);
  if (!legacyId) return { legacyId: null, outcome: 'ERROR', message: 'MISSING_LEGACY_ID' };
  if (!title) return { legacyId, outcome: 'ERROR', message: 'MISSING_TITLE' };
  if (await alreadyMapped(tx, 'content', legacyId)) return { legacyId, outcome: 'SKIPPED', message: 'ALREADY_IMPORTED' };
  const type = contentType(pick(row, ['board', 'type', 'category', '게시판']));
  const { markdown, images } = htmlToMarkdown(pick(row, ['body_html', 'body', 'content', '내용']) ?? '');
  stats.mediaReferences += images.length;
  let slug = slugify(pick(row, ['slug']) ?? '') || `legacy-${slugify(legacyId)}`;
  const legacyUrl = pick(row, ['legacy_url', 'url']);
  if (o.mode === 'DRY_RUN') return { legacyId, outcome: 'IMPORTED', message: `WOULD_IMPORT ${type}` };
  const clash = await maybeOne(tx, `SELECT 1 FROM cms_entries WHERE entry_type = $1 AND slug = $2 AND locale = 'ko-KR'`, [type, slug]);
  if (clash) slug = `${slug}-${slugify(legacyId)}`.slice(0, 120);
  const publishedAt = parseLegacyDate(pick(row, ['published_at', 'created_at', '작성일']));
  const publish = !!o.publish;
  const e = await one<{ id: string }>(
    tx,
    `INSERT INTO cms_entries(entry_type, slug, locale, title, summary, body_md, data, status, published_at)
     VALUES ($1,$2,'ko-KR',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [type, slug, title.slice(0, 300), markdown.slice(0, 200), markdown, JSON.stringify({ legacy: { source: o.source, legacyId, legacyUrl, media: images } }), publish ? 'PUBLISHED' : 'DRAFT', publish ? publishedAt ?? new Date() : null],
  );
  await mapId(tx, 'content', legacyId, e.id, batchId);
  const target = ENTRY_PATHS[type]?.(slug);
  if (legacyUrl && target) {
    // 301 candidate (unapproved until business sign-off)
    await tx.query(
      `INSERT INTO seo_redirects(legacy_path, target_path, status_code, approved, source) VALUES ($1,$2,301,false,'migration') ON CONFLICT (legacy_path) DO NOTHING`,
      [normalizePath(legacyUrl), target],
    );
    stats.redirectCandidates++;
  }
  return { legacyId, outcome: 'IMPORTED' };
}

// ---------------------------------------------------------------- media

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'application/pdf': '.pdf' };
const MIME_BY_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };

async function importMedia(tx: Tx, ctx: Ctx, o: ImportOptions, batchId: string, row: Record<string, string>, stats: Record<string, number>): Promise<RowOutcome> {
  const legacyId = pick(row, ['media_id', 'legacy_id', 'id']);
  const file = pick(row, ['file', 'local_path', 'filename', 'path']);
  const url = pick(row, ['url', 'source_url', 'legacy_url']);
  if (!legacyId) return { legacyId: null, outcome: 'ERROR', message: 'MISSING_LEGACY_ID' };
  if (await alreadyMapped(tx, 'media', legacyId)) return { legacyId, outcome: 'SKIPPED', message: 'ALREADY_IMPORTED' };
  if (!file || !o.mediaDir) return { legacyId, outcome: 'ERROR', message: 'MISSING_FILE' };
  const full = path.resolve(o.mediaDir, file);
  if (!full.startsWith(path.resolve(o.mediaDir) + path.sep)) return { legacyId, outcome: 'ERROR', message: 'PATH_TRAVERSAL' };
  let bytes: Buffer;
  try {
    bytes = await readFile(full);
  } catch {
    stats.brokenMedia++;
    return { legacyId, outcome: 'ERROR', message: 'MISSING_FILE' };
  }
  if (!bytes.length) {
    stats.brokenMedia++;
    return { legacyId, outcome: 'ERROR', message: 'EMPTY_FILE' };
  }
  const checksum = sha256Hex(bytes);
  const declared = pick(row, ['sha256', 'checksum']);
  if (declared && declared.toLowerCase() !== checksum) {
    stats.brokenMedia++;
    return { legacyId, outcome: 'ERROR', message: 'CHECKSUM_MISMATCH' };
  }
  const ext = path.extname(file).toLowerCase();
  const mime = pick(row, ['mime', 'mime_type', 'content_type']) ?? MIME_BY_EXT[ext] ?? 'application/octet-stream';
  stats.bytes += bytes.length;
  if (o.mode === 'DRY_RUN') return { legacyId, outcome: 'IMPORTED', message: `WOULD_IMPORT sha256=${checksum.slice(0, 12)}` };
  const key = `legacy/${o.source.toLowerCase()}/${checksum}${EXT[mime] ?? ext}`;
  if (o.uploader) await o.uploader(key, bytes, mime);
  const publicUrl = o.cdnBaseUrl ? `${o.cdnBaseUrl.replace(/\/$/, '')}/${key}` : null;
  const ins = await maybeOne<{ id: string }>(
    tx,
    `INSERT INTO media_assets(storage_key, public_url, purpose, visibility, mime_type, byte_size, sha256, moderation_status, status, ready_at)
     VALUES ($1,$2,'CMS','PUBLIC',$3,$4,$5,'PENDING','READY', now()) ON CONFLICT (storage_key) DO NOTHING RETURNING id`,
    [key, publicUrl, mime, bytes.length, checksum],
  );
  const mediaId = ins?.id ?? (await one<{ id: string }>(tx, `SELECT id FROM media_assets WHERE storage_key = $1`, [key])).id;
  if (!ins) stats.deduplicated++;
  await mapId(tx, 'media', legacyId, mediaId, batchId);
  if (url) await mapId(tx, 'media_url', url, mediaId, batchId);
  return { legacyId, outcome: 'IMPORTED' };
}

// ---------------------------------------------------------------- redirects

async function importRedirect(tx: Tx, ctx: Ctx, o: ImportOptions, row: Record<string, string>, seen: Set<string>): Promise<RowOutcome> {
  const from = pick(row, ['legacy_path', 'legacy_url', 'from', 'old_url', 'source']);
  const to = pick(row, ['target_path', 'to', 'new_url', 'target']);
  if (!from || !to) return { legacyId: from, outcome: 'ERROR', message: 'MISSING_COLUMNS' };
  const legacy = normalizePath(from);
  try {
    assertSafeTarget(to);
  } catch {
    return { legacyId: legacy, outcome: 'ERROR', message: 'UNSAFE_REDIRECT_TARGET' };
  }
  if (seen.has(legacy)) return { legacyId: legacy, outcome: 'SKIPPED', message: 'DUPLICATE_IN_FILE' };
  seen.add(legacy);
  const code = Number(pick(row, ['status_code', 'code']) ?? 301);
  if (![301, 302, 307, 308].includes(code)) return { legacyId: legacy, outcome: 'ERROR', message: 'INVALID_STATUS_CODE' };
  const existing = await maybeOne<{ target_path: string }>(tx, `SELECT target_path FROM seo_redirects WHERE legacy_path = $1`, [legacy]);
  if (existing?.target_path === to) return { legacyId: legacy, outcome: 'SKIPPED', message: 'UNCHANGED' };
  if (o.mode === 'DRY_RUN') return { legacyId: legacy, outcome: 'IMPORTED', message: existing ? 'WOULD_UPDATE' : 'WOULD_INSERT' };
  const res = await upsertRedirects(tx, ctx, [{ legacyPath: legacy, targetPath: to, statusCode: code as 301, approved: !!o.approve }], { source: 'migration', canApprove: !!o.approve });
  if (res.errors.length) return { legacyId: legacy, outcome: 'ERROR', message: res.errors[0].error };
  return { legacyId: legacy, outcome: 'IMPORTED' };
}

// ---------------------------------------------------------------- batch runner

export async function runImport(pool: pg.Pool, entity: Entity, o: ImportOptions, ctx: Ctx = migrationCtx(`migration-${entity}-${Date.now()}`)): Promise<BatchResult> {
  const fileHash = sha256Hex(o.content);
  const rows = parseCsv(o.content);
  const batch = await one<{ id: string }>(
    pool,
    `INSERT INTO migration_batches(source, entity_type, mode, source_file_hash, source_count) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [o.source, entity, o.mode, fileHash, rows.length],
  );
  const stats: Record<string, number> = { passwordResetRequired: 0, consentRecords: 0, phoneUnparseable: 0, mediaReferences: 0, redirectCandidates: 0, brokenMedia: 0, deduplicated: 0, bytes: 0 };
  const messages: Record<string, number> = {};
  try {
    const counts = await withTx(pool, async (tx) => {
      const c = { imported: 0, skipped: 0, errors: 0 };
      const seenEmails = new Set<string>();
      const seenPaths = new Set<string>();
      for (const row of rows) {
        const r = await guarded(
          tx,
          () => {
            switch (entity) {
              case 'members':
                return importMember(tx, ctx, o, batch.id, fileHash, row, seenEmails, stats);
              case 'content':
                return importContent(tx, ctx, o, batch.id, row, stats);
              case 'media':
                return importMedia(tx, ctx, o, batch.id, row, stats);
              case 'redirects':
                return importRedirect(tx, ctx, o, row, seenPaths);
            }
          },
          Object.values(row)[0] ?? null,
        );
        if (r.outcome === 'IMPORTED') c.imported++;
        else if (r.outcome === 'SKIPPED') c.skipped++;
        else c.errors++;
        if (r.message) messages[r.message.split(' ')[0]] = (messages[r.message.split(' ')[0]] ?? 0) + 1;
        await tx.query(`INSERT INTO migration_audit(batch_id, legacy_type, legacy_id, outcome, message) VALUES ($1,$2,$3,$4,$5)`, [
          batch.id,
          LEGACY_TYPE[entity],
          r.legacyId,
          r.outcome,
          r.message ?? null,
        ]);
      }
      const report = { file: o.fileName, stats, outcomes: messages };
      await tx.query(
        `UPDATE migration_batches SET status = 'SUCCEEDED', imported_count = $2, skipped_count = $3, error_count = $4, report = $5, finished_at = now() WHERE id = $1`,
        [batch.id, c.imported, c.skipped, c.errors, JSON.stringify(report)],
      );
      await emit(tx, ctx, {
        aggregateType: 'migration_batch',
        aggregateId: batch.id,
        eventType: 'migration.batch.completed',
        payload: { batchId: batch.id, source: o.source, entity, mode: o.mode, sourceCount: rows.length, ...c },
      });
      return c;
    });
    return { batchId: batch.id, entity, mode: o.mode, source: o.source, sourceFileHash: fileHash, sourceCount: rows.length, ...counts, report: { file: o.fileName, stats, outcomes: messages } };
  } catch (err: any) {
    await pool.query(`UPDATE migration_batches SET status = 'FAILED', report = $2, finished_at = now() WHERE id = $1`, [batch.id, JSON.stringify({ error: String(err?.message ?? err) })]);
    throw err;
  }
}

// ---------------------------------------------------------------- reconciliation

export interface ReconcileInput {
  source: string;
  /** URL inventory (sitemap.xml or CSV) used to prove every legacy URL has a mapping */
  inventoryText?: string;
  /** legacy orders export (read-only, for amount reconciliation; orders are not migrated as transactions) */
  ordersText?: string;
}

export async function reconcile(db: Db, input: ReconcileInput) {
  const latest = await q(
    db,
    `SELECT DISTINCT ON (entity_type, mode) id, entity_type, mode, status, source_file_hash, source_count, imported_count, skipped_count, error_count, report, finished_at
       FROM migration_batches WHERE source = $1 ORDER BY entity_type, mode, started_at DESC`,
    [input.source],
  );
  const entities: Record<string, any> = {};
  for (const b of latest) {
    entities[b.entity_type] ??= {};
    entities[b.entity_type][b.mode] = {
      batchId: b.id,
      status: b.status,
      sourceFileHash: b.source_file_hash,
      sourceCount: b.source_count,
      imported: b.imported_count,
      skipped: b.skipped_count,
      errors: b.error_count,
      balanced: b.source_count === b.imported_count + b.skipped_count + b.error_count,
      stats: b.report?.stats ?? {},
    };
  }
  const idMap = Object.fromEntries((await q(db, `SELECT legacy_type, count(*)::int AS n FROM migration_id_map GROUP BY legacy_type`)).map((r) => [r.legacy_type, r.n]));
  const members = await one(
    db,
    `SELECT count(*)::int AS users, count(*) FILTER (WHERE requires_password_reset)::int AS reset_required,
            (SELECT count(*)::int FROM consent_records WHERE version = $2) AS consent_records
       FROM migration_user_flags WHERE source = $1`,
    [input.source, `legacy-${input.source.toLowerCase()}`],
  );
  // media references in imported content vs imported media URLs
  const refs = await q<{ url: string; mapped: boolean }>(
    db,
    `SELECT DISTINCT r.url, EXISTS (SELECT 1 FROM migration_id_map m WHERE m.legacy_type = 'media_url' AND m.legacy_id = r.url) AS mapped
       FROM cms_entries e, jsonb_array_elements_text(coalesce(e.data->'legacy'->'media', '[]'::jsonb)) AS r(url)
      WHERE e.data->'legacy'->>'source' = $1`,
    [input.source],
  );
  const media = { referenced: refs.length, resolved: refs.filter((r) => r.mapped).length, broken: refs.filter((r) => !r.mapped).map((r) => r.url) };

  let urls: any = null;
  if (input.inventoryText) {
    const inv = buildUrlInventory(input.inventoryText);
    const paths = inv.items.map((i) => normalizePath(i.path));
    const red = await q<{ legacy_path: string; approved: boolean }>(db, `SELECT legacy_path, approved FROM seo_redirects WHERE legacy_path = ANY($1::text[])`, [paths]);
    const map = new Map(red.map((r) => [r.legacy_path, r.approved]));
    const unmapped = paths.filter((p) => !map.has(p) && p !== '/');
    urls = {
      inventoryHash: inv.hash,
      total: paths.length,
      mappedApproved: paths.filter((p) => map.get(p) === true).length,
      mappedPendingApproval: paths.filter((p) => map.get(p) === false).length,
      unmapped: unmapped.length,
      unmappedSample: unmapped.slice(0, 50),
      byKind: inv.items.reduce<Record<string, number>>((acc, i) => ((acc[i.kind] = (acc[i.kind] ?? 0) + 1), acc), {}),
    };
  }

  let amounts: any = null;
  if (input.ordersText) {
    const rows = parseCsv(input.ordersText);
    const byCurrency: Record<string, { orders: number; amountMinor: number }> = {};
    const invalid: string[] = [];
    for (const r of rows) {
      const raw = pick(r, ['amount', 'total', 'paid_amount', '결제금액', '주문금액']);
      const cur = (pick(r, ['currency']) ?? 'KRW').toUpperCase();
      const n = raw ? Number(raw.replace(/[,\s원]/g, '')) : NaN;
      if (!Number.isFinite(n) || n < 0) {
        invalid.push(pick(r, ['order_id', 'id', '주문번호']) ?? '?');
        continue;
      }
      const minor = cur === 'KRW' || cur === 'JPY' ? Math.round(n) : Math.round(n * 100);
      byCurrency[cur] ??= { orders: 0, amountMinor: 0 };
      byCurrency[cur].orders++;
      byCurrency[cur].amountMinor += minor;
    }
    amounts = { orders: rows.length, byCurrency, invalidRows: invalid, ordersFileHash: sha256Hex(input.ordersText), note: 'Legacy orders are archived for reconciliation only; they are not replayed as JETPOOL payments or ledger entries.' };
  }

  const applyOk = (e: string) => {
    const a = entities[e]?.APPLY;
    return !!a && a.status === 'SUCCEEDED' && a.balanced && a.errors === 0;
  };
  const checks = [
    { check: 'members.batch_balanced_no_errors', pass: applyOk('members') },
    { check: 'members.id_map_matches_imported', pass: (idMap.member ?? 0) === members.users },
    { check: 'content.batch_balanced_no_errors', pass: applyOk('content') },
    { check: 'media.batch_balanced_no_errors', pass: applyOk('media') },
    { check: 'media.no_broken_references', pass: media.broken.length === 0 },
    { check: 'redirects.batch_balanced_no_errors', pass: applyOk('redirects') },
    ...(urls ? [{ check: 'urls.all_inventory_urls_mapped', pass: urls.unmapped === 0 }, { check: 'urls.all_mappings_approved', pass: urls.mappedPendingApproval === 0 }] : []),
    ...(amounts ? [{ check: 'orders.no_invalid_amounts', pass: amounts.invalidRows.length === 0 }] : []),
  ];
  return {
    source: input.source,
    generatedAt: new Date().toISOString(),
    readyForCutover: checks.every((c) => c.pass),
    checks,
    entities,
    idMap,
    members: { imported: members.users, passwordResetRequired: members.reset_required, consentRecords: members.consent_records },
    media,
    urls,
    amounts,
  };
}

export function renderReconcileMarkdown(r: Awaited<ReturnType<typeof reconcile>>): string {
  const lines = [`# Legacy migration reconciliation — ${r.source}`, '', `Generated: ${r.generatedAt}`, '', `**Ready for cutover:** ${r.readyForCutover ? 'YES' : 'NO'}`, '', '## Checks', '', '| Check | Result |', '|---|---|'];
  for (const c of r.checks) lines.push(`| ${c.check} | ${c.pass ? 'PASS' : 'FAIL'} |`);
  lines.push('', '## Batches (latest per entity/mode)', '', '| Entity | Mode | Status | Source rows | Imported | Skipped | Errors | Balanced | File SHA-256 |', '|---|---|---|---|---|---|---|---|---|');
  for (const [entity, modes] of Object.entries(r.entities)) {
    for (const [mode, b] of Object.entries(modes as Record<string, any>)) {
      lines.push(`| ${entity} | ${mode} | ${b.status} | ${b.sourceCount} | ${b.imported} | ${b.skipped} | ${b.errors} | ${b.balanced ? 'yes' : 'no'} | \`${String(b.sourceFileHash).slice(0, 16)}…\` |`);
    }
  }
  lines.push('', '## Members', '', `- Imported: ${r.members.imported}`, `- Password reset required (legacy hash not compatible): ${r.members.passwordResetRequired}`, `- Consent evidence records: ${r.members.consentRecords}`);
  lines.push('', '## Media references', '', `- Referenced in content: ${r.media.referenced}`, `- Resolved to imported media: ${r.media.resolved}`, `- Broken: ${r.media.broken.length}`);
  for (const b of r.media.broken.slice(0, 50)) lines.push(`  - ${b}`);
  if (r.urls) {
    lines.push('', '## URL mappings (301)', '', `- Inventory URLs: ${r.urls.total} (inventory hash \`${r.urls.inventoryHash.slice(0, 16)}…\`)`, `- Mapped & approved: ${r.urls.mappedApproved}`, `- Mapped, pending approval: ${r.urls.mappedPendingApproval}`, `- Unmapped: ${r.urls.unmapped}`);
    for (const u of r.urls.unmappedSample) lines.push(`  - ${u}`);
  }
  if (r.amounts) {
    lines.push('', '## Legacy order amounts', '', `- Orders: ${r.amounts.orders}`);
    for (const [cur, v] of Object.entries(r.amounts.byCurrency as Record<string, any>)) lines.push(`- ${cur}: ${v.orders} orders, ${v.amountMinor} minor units`);
    lines.push(`- Invalid rows: ${r.amounts.invalidRows.length}`, '', `> ${r.amounts.note}`);
  }
  return lines.join('\n') + '\n';
}
