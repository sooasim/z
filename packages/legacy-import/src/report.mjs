import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { outPaths } from './config.mjs';
import { findOrphans, foreignPublisherDirs } from './publish.mjs';
import { atomicWrite, formatBytes, readJson, uniq, writeJson } from './util.mjs';
import { hostMatches } from './url.mjs';

const DOC_RE = /\.(pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip)$/i;

/**
 * Step 7 — reconciliation: per-page counts, failed downloads with reasons, duplicates, bytes and coverage
 * (unique media URLs referenced on pages vs resolved to a downloaded file). Implicit references (an undeclared
 * /favicon.ico) do not count against coverage when missing.
 */

async function dirBytes(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        bytes += (await stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

export async function buildReport(cfg) {
  const paths = outPaths(cfg);
  const inv = await readJson(paths.inventory);
  const st = await readJson(paths.assets);
  const dl = await readJson(paths.downloads, { urls: {} });
  const manifest = await readJson(paths.manifest);
  if (!inv) throw new Error('inventory.json missing — run the crawl step first');
  const refs = st?.refs ?? [];
  const counted = refs.filter((r) => !(r.implicit && !r.sha256));
  const byUrl = new Map();
  for (const r of counted) {
    const cur = byUrl.get(r.url) ?? { url: r.url, resolved: false, kind: r.kind, vias: new Set(), pages: new Set(), errors: [] };
    cur.resolved ||= !!r.sha256;
    cur.vias.add(r.via);
    cur.pages.add(r.pageUrl);
    if (!r.sha256) cur.errors.push(...r.errors, ...(r.notAttempted ?? []).map((u) => ({ url: u, error: 'NOT_ATTEMPTED' })));
    byUrl.set(r.url, cur);
  }
  const unique = [...byUrl.values()];
  const resolved = unique.filter((u) => u.resolved).length;
  const coverage = unique.length ? (resolved / unique.length) * 100 : 100;
  const failed = unique
    .filter((u) => !u.resolved)
    .map((u) => ({ url: u.url, kind: u.kind, via: [...u.vias], pages: [...u.pages], reasons: uniq(u.errors.map((e) => e.error)), attempts: u.errors }));
  const hostsBlocked = {};
  const hostsProxyDenied = {};
  for (const f of failed) {
    const h = new URL(f.url).host;
    if (f.reasons.some((r) => /HOST_NOT_ALLOWED/.test(r))) hostsBlocked[h] = (hostsBlocked[h] ?? 0) + 1;
    if (f.reasons.some((r) => /PROXY_\d/.test(r))) hostsProxyDenied[h] = (hostsProxyDenied[h] ?? 0) + 1;
  }
  const reasons = {};
  for (const f of failed) for (const r of f.reasons) reasons[r] = (reasons[r] ?? 0) + 1;

  const assets = Object.values(st?.assets ?? {});
  const duplicates = assets.filter((a) => a.sourceUrls.length > 1).map((a) => ({ sha256: a.sha256, urls: a.sourceUrls, bytes: a.bytes }));
  const originalBytes = assets.reduce((n, a) => n + a.bytes, 0);
  const downloadedBytes = Object.values(dl.urls).filter((d) => d.status === 'ok').reduce((n, d) => n + (d.bytes ?? 0), 0);
  const published = await dirBytes(cfg.publicDir);

  const pages = (inv.pages ?? []).map((p) => {
    const rs = counted.filter((r) => r.pageUrl === p.url);
    const urls = uniq(rs.map((r) => r.url));
    const ok = urls.filter((u) => byUrl.get(u)?.resolved);
    const mp = manifest?.pages?.find((x) => x.url === p.url);
    return {
      url: p.url, ok: p.ok, status: p.status ?? null, error: p.error ?? null, aliasOf: p.aliasOf ?? null, title: p.title ?? null,
      mediaRefs: rs.length, uniqueMedia: urls.length, downloaded: ok.length, failed: urls.length - ok.length,
      images: mp?.images?.length ?? 0, videos: mp?.videos?.length ?? 0, embeds: (p.embeds ?? []).length,
    };
  });
  const embeds = Object.values(st?.embeds ?? {});
  const foreign = new Set(await foreignPublisherDirs(cfg.publicDir));
  const orphans = (await findOrphans(cfg.publicDir, new Set(Object.keys(manifest?.assets ?? {})))).filter((d) => !foreign.has(d));
  const report = {
    generatedAt: new Date().toISOString(),
    source: { startUrls: inv.startUrls, siteHosts: inv.siteHosts, assetHosts: inv.assetHosts, crawlFinished: inv.finished },
    pages: {
      total: inv.pages.length,
      ok: inv.pages.filter((p) => p.ok && !p.aliasOf && !p.template).length,
      aliases: inv.pages.filter((p) => p.aliasOf).length,
      templates: inv.pages.filter((p) => p.template).map((p) => ({ url: p.url, title: p.title ?? null })),
      failed: inv.pages.filter((p) => !p.ok).map((p) => ({ url: p.url, error: p.error, status: p.status ?? null })),
      skipped: inv.skipped,
    },
    robots: inv.robots,
    sitemaps: inv.sitemaps,
    media: {
      references: counted.length,
      uniqueUrls: unique.length,
      resolved,
      failed: failed.length,
      coveragePct: Math.floor(coverage * 100) / 100,
      // an empty crawl is never "complete"
      complete: failed.length === 0 && inv.pages.some((p) => p.ok),
      reasons,
      hostsNotAllowed: hostsBlocked,
      hostsDeniedByProxy: hostsProxyDenied,
      failedList: failed,
      implicitMissing: refs.filter((r) => r.implicit && !r.sha256).map((r) => r.url),
    },
    assets: {
      unique: assets.length,
      images: assets.filter((a) => a.kind === 'image').length,
      videos: assets.filter((a) => a.kind === 'video').length,
      duplicateGroups: duplicates.length,
      duplicateUrls: duplicates.reduce((n, d) => n + d.urls.length - 1, 0),
      duplicates,
      originalBytes,
      downloadedBytes,
      publishedFiles: published.files,
      publishedBytes: published.bytes,
      orphans,
      foreignPublisherDirs: foreign.size,
    },
    embeds: embeds.map((e) => ({ id: e.id, provider: e.provider, watchUrl: e.watchUrl, pages: e.pageUrls.length })),
    otherIframes: uniq((inv.pages ?? []).flatMap((p) => (p.otherIframes ?? []).map((x) => x.url))),
    // brochures / forms linked from pages on the site's own hosts — not media, so review and migrate by hand
    documents: uniq(
      (inv.pages ?? []).flatMap((p) => (p.links ?? []).map((l) => l.url)).filter((u) => {
        try {
          return DOC_RE.test(new URL(u).pathname) && hostMatches(u, [...(inv.siteHosts ?? []), ...(inv.assetHosts ?? [])]);
        } catch {
          return false;
        }
      }),
    ),
    perPage: pages,
    manifest: manifest ? { generatedAt: manifest.generatedAt, contentSha256: manifest.contentSha256, pages: manifest.pages.length, assets: Object.keys(manifest.assets).length } : null,
  };
  return report;
}

export function renderReport(r) {
  const L = [];
  const pct = r.media.coveragePct.toFixed(2);
  L.push('# Legacy media migration report — WONT Travel Club → JETPOOL', '');
  L.push(`Generated: ${r.generatedAt}`, '');
  L.push(`Start URLs: ${r.source.startUrls.join(', ')}  `, `Site hosts: ${r.source.siteHosts.join(', ')}  `, `Asset hosts: ${r.source.assetHosts.join(', ')}`, '');
  L.push(`**Media coverage: ${pct}%** (${r.media.resolved}/${r.media.uniqueUrls} unique referenced media URLs downloaded) — ${r.media.complete ? 'COMPLETE' : 'INCOMPLETE'}`, '');
  L.push('## Summary', '', '| Metric | Value |', '|---|---|');
  const rows = [
    ['Pages crawled (ok / failed / aliases)', `${r.pages.ok} / ${r.pages.failed.length} / ${r.pages.aliases}`],
    ['URLs skipped (robots, excluded, limits)', r.pages.skipped.length],
    ['Sixshop template pages skipped', r.pages.templates.length],
    ['Media references on pages', r.media.references],
    ['Unique media URLs', r.media.uniqueUrls],
    ['Downloaded (resolved)', r.media.resolved],
    ['Failed / broken', r.media.failed],
    ['Unique assets (sha256)', `${r.assets.unique} (${r.assets.images} images, ${r.assets.videos} videos)`],
    ['Duplicate URLs (same bytes)', `${r.assets.duplicateUrls} in ${r.assets.duplicateGroups} group(s)`],
    ['Embeds (YouTube/Vimeo, not downloaded)', r.embeds.length],
    ['Original bytes', formatBytes(r.assets.originalBytes)],
    ['Published files / bytes', `${r.assets.publishedFiles} / ${formatBytes(r.assets.publishedBytes)}`],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  if (r.media.failed) {
    L.push('', '## Failed downloads', '', '| URL | Reason(s) | Via | Pages |', '|---|---|---|---|');
    for (const f of r.media.failedList.slice(0, 500)) L.push(`| ${f.url} | ${f.reasons.join(', ')} | ${f.via.join(', ')} | ${f.pages.slice(0, 3).join('<br>')}${f.pages.length > 3 ? ` (+${f.pages.length - 3})` : ''} |`);
    if (Object.keys(r.media.hostsNotAllowed).length) {
      L.push('', 'Hosts not in the asset allowlist (add with `--asset-host <host>` after confirming they belong to the site):', '');
      for (const [h, n] of Object.entries(r.media.hostsNotAllowed)) L.push(`- \`${h}\` — ${n} URL(s)`);
    }
    if (Object.keys(r.media.hostsDeniedByProxy ?? {}).length) {
      L.push('', 'Hosts denied by the egress proxy / network policy (allow them in the environment, then re-run with `--resume`):', '');
      for (const [h, n] of Object.entries(r.media.hostsDeniedByProxy)) L.push(`- \`${h}\` — ${n} URL(s)`);
    }
    L.push('', 'Reasons: ' + Object.entries(r.media.reasons).map(([k, v]) => `${k} × ${v}`).join(', '));
  }
  if (r.media.implicitMissing.length) L.push('', `Implicit references not found (not counted): ${r.media.implicitMissing.join(', ')}`);
  L.push('', '## Pages', '', '| Page | Title | Media refs | Unique | Downloaded | Failed | Images | Videos | Embeds |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of r.perPage) {
    const status = p.ok ? (p.aliasOf ? ` (alias of ${p.aliasOf})` : p.template ? ' (Sixshop template, skipped)' : '') : ` **${p.error}**`;
    L.push(`| ${p.url}${status} | ${(p.title ?? '').replace(/\|/g, '\\|')} | ${p.mediaRefs} | ${p.uniqueMedia} | ${p.downloaded} | ${p.failed} | ${p.images} | ${p.videos} | ${p.embeds} |`);
  }
  if (r.pages.templates.length) {
    L.push('', '## Sixshop template pages (skipped — default editor manual, sample images of another shop)', '', 'Re-run with `--include-template-pages` if any of these is real content.', '');
    for (const t of r.pages.templates) L.push(`- ${t.url} — ${t.title ?? ''}`);
  }
  if (r.pages.skipped.length) {
    L.push('', '## Skipped URLs', '', '| URL | Reason | Found on |', '|---|---|---|');
    for (const s of r.pages.skipped.slice(0, 500)) L.push(`| ${s.url} | ${s.reason} | ${s.from ?? ''} |`);
  }
  if (r.assets.duplicates.length) {
    L.push('', '## Duplicates (deduplicated by sha256)', '');
    for (const d of r.assets.duplicates.slice(0, 200)) L.push(`- \`${d.sha256.slice(0, 12)}\` (${formatBytes(d.bytes)}): ${d.urls.join(' · ')}`);
  }
  if (r.embeds.length) {
    L.push('', '## Embedded videos (recorded, not downloaded)', '');
    for (const e of r.embeds) L.push(`- ${e.provider} \`${e.id}\` — ${e.watchUrl} (${e.pages} page(s))`);
  }
  if (r.otherIframes.length) {
    L.push('', '## Other iframes (not migrated — review manually)', '');
    for (const u of r.otherIframes) L.push(`- ${u}`);
  }
  if (r.documents.length) {
    L.push('', '## Linked documents (not migrated automatically — review)', '');
    for (const u of r.documents) L.push(`- ${u}`);
  }
  if (r.assets.orphans.length) L.push('', `## Orphaned public directories (kept)`, '', r.assets.orphans.map((o) => `- ${o}`).join('\n'));
  if (r.assets.foreignPublisherDirs) {
    L.push('', '## Shared public directory', '', `> **Warning:** the public dir also contains ${r.assets.foreignPublisherDirs} asset director(ies) written by another publisher (\`<sha12>/original.<ext>\` layout). If that publisher prunes entries it does not know, it will delete this migration's files — publish with \`--public-dir\`/\`--url-prefix\` to a directory this tool owns, or let one pipeline own it.`);
  }
  L.push('', '## Robots / sitemaps', '');
  for (const rb of r.robots ?? []) L.push(`- robots ${rb.origin}: ${rb.status}${rb.crawlDelay ? `, crawl-delay ${rb.crawlDelay}s` : ''}, ${rb.rules} rule(s)`);
  for (const s of r.sitemaps ?? []) L.push(`- sitemap ${s.url}: ${s.ok ? `${s.urls} URL(s)` : s.error}`);
  return L.join('\n') + '\n';
}

export async function runReport(ctx) {
  const { cfg, log } = ctx;
  const paths = outPaths(cfg);
  const r = await buildReport(cfg);
  await writeJson(paths.reportJson, r);
  await atomicWrite(paths.reportMd, renderReport(r));
  log.info(`report: coverage ${r.media.coveragePct}% (${r.media.resolved}/${r.media.uniqueUrls}), ${r.media.failed} failed → ${paths.reportMd}`);
  return r;
}
