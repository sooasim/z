import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { outPaths } from './config.mjs';
import { buildImportPlan } from './plan.mjs';
import { ensureDir, readJson, toCsv, writeJson } from './util.mjs';

/**
 * Step 6a — platform import inputs in out/import/:
 *  plan.json       full plan (CMS entries, media rows, redirects, listing contexts) — consumed by packages/db/seed-legacy.mjs
 *  content.csv     → tsx apps/api/scripts/migrate-legacy.ts import-content   --file content.csv [--publish] [--apply]
 *  media.csv       → tsx apps/api/scripts/migrate-legacy.ts import-media     --file media.csv --media-dir <public-dir> [--apply]
 *  redirects.csv   → tsx apps/api/scripts/migrate-legacy.ts import-redirects --file redirects.csv [--apply]
 * Column names follow the aliases accepted by apps/api/src/modules/integrations/migration/importers.ts.
 */
export async function runImport(ctx) {
  const { cfg, log } = ctx;
  const paths = outPaths(cfg);
  const manifest = await readJson(paths.manifest);
  if (!manifest) throw new Error('manifest.json missing — run the publish step first');
  const plan = buildImportPlan(manifest);
  await ensureDir(paths.importDir);
  await writeJson(path.join(paths.importDir, 'plan.json'), plan);

  const content = plan.entries.map((e) => ({
    post_id: e.externalId,
    title: e.title,
    board: e.type === 'STORY' ? 'story' : 'legacy',
    slug: e.slug,
    legacy_url: e.legacyUrl,
    published_at: e.data.legacy.lastmod ?? '',
    body_html: e.bodyHtml,
    summary: e.summary,
    target_path: e.targetPath ?? '',
  }));
  await writeFile(path.join(paths.importDir, 'content.csv'), toCsv(content, ['post_id', 'title', 'board', 'slug', 'legacy_url', 'published_at', 'body_html', 'summary', 'target_path']));

  const pubPrefix = cfg.urlPrefix.replace(/\/$/, '');
  const relToPublicDir = (p) => (p && p.startsWith(`${pubPrefix}/`) ? p.slice(pubPrefix.length + 1) : p?.replace(/^\//, ''));
  const media = plan.media.map((m) => {
    const file = relToPublicDir(m.originalPath ?? m.publicUrl);
    return {
      media_id: `wont:${m.assetId}`,
      file,
      url: m.publicUrl,
      sha256: m.originalPath ? m.sha256 : '',
      mime: m.originalPath ? m.mime : 'image/webp',
      alt: m.alt ?? '',
      width: m.width ?? '',
      height: m.height ?? '',
      source_url: m.sourceUrls[0] ?? '',
      page_url: m.pageUrls[0] ?? '',
    };
  });
  await writeFile(path.join(paths.importDir, 'media.csv'), toCsv(media, ['media_id', 'file', 'url', 'sha256', 'mime', 'alt', 'width', 'height', 'source_url', 'page_url']));

  await writeFile(
    path.join(paths.importDir, 'redirects.csv'),
    toCsv(plan.redirects.map((r) => ({ legacy_path: r.legacyPath, target_path: r.targetPath, status_code: r.statusCode, reason: r.reason })), ['legacy_path', 'target_path', 'status_code', 'reason']),
  );
  log.info(`import: ${plan.entries.length} CMS entr(ies), ${plan.media.length} media row(s), ${plan.redirects.length} redirect candidate(s) → ${paths.importDir}`);
  return plan;
}
