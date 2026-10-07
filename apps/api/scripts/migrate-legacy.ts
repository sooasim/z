/**
 * MIG-01 legacy WONT/Sixshop migration CLI. DRY_RUN is the default; pass --apply to write.
 *
 *   tsx scripts/migrate-legacy.ts inventory        --file sitemap.xml|urls.csv [--out inventory.json]
 *   tsx scripts/migrate-legacy.ts import-members   --file members.csv   [--source SIXSHOP] [--apply]
 *   tsx scripts/migrate-legacy.ts import-content   --file posts.csv     [--publish] [--apply]
 *   tsx scripts/migrate-legacy.ts import-media     --file media.csv --media-dir ./export/media [--stage-dir ./staged] [--cdn-base-url https://cdn…] [--apply]
 *   tsx scripts/migrate-legacy.ts import-redirects --file redirects.csv [--approve] [--apply]
 *   tsx scripts/migrate-legacy.ts reconcile        [--inventory sitemap.xml] [--orders orders.csv] [--out report]   (writes report.md + report.json)
 *
 * Env: DATABASE_URL (default postgres://postgres@localhost:5432/jetpool). Only official export files are accepted as
 * input — never scrape passwords or payment data (v1 whitepaper, migration procedure).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/platform/db.js';
import { buildUrlInventory } from '../src/modules/integrations/migration/parse.js';
import { migrationCtx, reconcile, renderReconcileMarkdown, runImport, type Entity } from '../src/modules/integrations/migration/importers.js';

interface Args { _: string[]; [k: string]: string | boolean | string[] }

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else (out._ as string[]).push(a);
  }
  return out;
}

const USAGE = `usage: migrate-legacy <inventory|import-members|import-content|import-media|import-redirects|reconcile> [--file f] [--source SIXSHOP|WONT] [--apply] [--out path]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const source = String(args.source ?? 'SIXSHOP').toUpperCase();
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  if (!cmd) {
    console.error(USAGE);
    process.exit(2);
  }

  if (cmd === 'inventory') {
    const file = str('file');
    if (!file) throw new Error('--file is required');
    const inv = buildUrlInventory(await readFile(file, 'utf8'));
    const result = { generatedAt: new Date().toISOString(), sourceFile: path.basename(file), sourceHash: inv.hash, sourceKind: inv.sourceKind, count: inv.items.length, items: inv.items };
    const out = str('out') ?? 'legacy-inventory.json';
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(`inventory: ${inv.items.length} unique URLs → ${out} (sha256 ${inv.hash})`);
    return;
  }

  const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool', 4);
  try {
    if (cmd === 'reconcile') {
      const report = await reconcile(pool, {
        source,
        inventoryText: str('inventory') ? await readFile(str('inventory')!, 'utf8') : undefined,
        ordersText: str('orders') ? await readFile(str('orders')!, 'utf8') : undefined,
      });
      const base = (str('out') ?? `reconcile-${source.toLowerCase()}`).replace(/\.(md|json)$/, '');
      await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
      await writeFile(`${base}.md`, renderReconcileMarkdown(report));
      console.log(`reconcile: readyForCutover=${report.readyForCutover} → ${base}.md, ${base}.json`);
      if (!report.readyForCutover) process.exitCode = 1;
      return;
    }

    const entityByCmd: Record<string, Entity> = { 'import-members': 'members', 'import-content': 'content', 'import-media': 'media', 'import-redirects': 'redirects' };
    const entity = entityByCmd[cmd];
    if (!entity) {
      console.error(USAGE);
      process.exit(2);
    }
    const file = str('file');
    if (!file) throw new Error('--file is required');
    const stageDir = str('stage-dir');
    const result = await runImport(
      pool,
      entity,
      {
        source,
        mode: args.apply === true ? 'APPLY' : 'DRY_RUN',
        fileName: path.basename(file),
        content: await readFile(file, 'utf8'),
        mediaDir: str('media-dir'),
        cdnBaseUrl: str('cdn-base-url') ?? process.env.CDN_BASE_URL,
        publish: args.publish === true,
        approve: args.approve === true,
        uploader: stageDir
          ? async (key, bytes) => {
              const dest = path.join(stageDir, key);
              await mkdir(path.dirname(dest), { recursive: true });
              await writeFile(dest, bytes);
            }
          : undefined,
      },
      migrationCtx(`migration-cli-${randomUUID()}`),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'migrate-legacy.ts'));
if (isMain) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
