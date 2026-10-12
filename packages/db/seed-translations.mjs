/**
 * Load `data/translations/demo.json` into the `content_translations` cache.
 *
 * The cache is normally filled by the model — lazily on read, or up front by
 * `apps/api/scripts/translate-content.ts`. Both need ANTHROPIC_API_KEY, and the GitHub Pages demo has no
 * server at all: it replays recorded fixtures. So without a pre-warmed cache the demo can never show
 * translated listings, however well the feature works.
 *
 * This writes the same rows the model would, through the same key (sha256 of the source string), from a
 * committed file. It is additive and idempotent: a translation produced by the model later simply wins the
 * ON CONFLICT race or is already there.
 *
 *   node packages/db/seed-translations.mjs            # DATABASE_URL from the environment
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEMO_TRANSLATIONS = path.join(root, 'data/translations/demo.json');

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** "ko-KR → ja-JP" → 'ja-JP'. Only the target matters; the source is always the catalogue language. */
const targetOf = (key) => key.split('→').pop()?.trim();

/** Rows as `{ locale, source, translated }`, skipping the `_readme` block. */
export function readDemoTranslations(file = DEMO_TRANSLATIONS) {
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const out = [];
  for (const [key, table] of Object.entries(doc)) {
    if (key.startsWith('_') || typeof table !== 'object') continue;
    const locale = targetOf(key);
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale ?? '')) throw new Error(`bad locale key in ${path.basename(file)}: ${key}`);
    for (const [source, translated] of Object.entries(table)) {
      if (typeof translated === 'string' && translated.trim() && translated !== source) out.push({ locale, source, translated });
    }
  }
  return out;
}

export async function seedTranslations(db, file = DEMO_TRANSLATIONS) {
  const rows = readDemoTranslations(file);
  if (!rows.length) return 0;
  const res = await db.query(
    `INSERT INTO content_translations(source_hash, target_locale, translated, provider, model)
     SELECT * FROM unnest($1::char(64)[], $2::text[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (source_hash, target_locale) DO NOTHING`,
    [
      rows.map((r) => hash(r.source)),
      rows.map((r) => r.locale),
      rows.map((r) => r.translated),
      rows.map(() => 'seed'),
      rows.map(() => 'demo.json'),
    ],
  );
  return res.rowCount ?? 0;
}

// Direct run: `node packages/db/seed-translations.mjs`
if (import.meta.url === `file://${process.argv[1]?.split(path.sep).join('/')}` || process.argv[1]?.endsWith('seed-translations.mjs')) {
  const url = process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/jetpool';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const all = readDemoTranslations();
  const written = await seedTranslations(client);
  const locales = [...new Set(all.map((r) => r.locale))].sort();
  console.log(`[seed-translations] ${all.length} demo translation(s) in ${locales.join(', ')} — ${written} new`);
  await client.end();
}
