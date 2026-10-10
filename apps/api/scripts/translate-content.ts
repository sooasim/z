/**
 * Warm the machine-translation cache for member-written content, so readers never pay the "first viewer sees
 * the source text" cost and so a fixture recording (scripts/pages/record.sh) captures translated copy.
 *
 * The read path fills the cache lazily in the background; this does the same work up front for everything
 * already in the database. It writes only to `content_translations` — no domain table is touched.
 *
 *   ANTHROPIC_API_KEY=… tsx scripts/translate-content.ts                 # every shipped locale
 *   ANTHROPIC_API_KEY=… tsx scripts/translate-content.ts --locale ja-JP  # one locale
 *   tsx scripts/translate-content.ts --dry-run                           # what would be translated
 */
import pg from 'pg';
import { loadConfig } from '../src/platform/config.js';
import { sourceHash, storeTranslations, translatable } from '../src/platform/translate.js';
import { SOURCE_LOCALE, SUPPORTED_LOCALES } from '../src/platform/content-locale.js';
import { ClaudeTranslator } from '../src/modules/ai/translator.js';

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes('--dry-run');
const BATCH = 25;

/** Every member-written string the public read paths can show. */
const SOURCES: Array<{ what: string; sql: string }> = [
  { what: 'listing title', sql: `SELECT DISTINCT title AS t FROM properties WHERE status = 'PUBLISHED' AND title IS NOT NULL` },
  { what: 'listing summary', sql: `SELECT DISTINCT summary AS t FROM properties WHERE status = 'PUBLISHED' AND summary IS NOT NULL` },
  { what: 'listing description', sql: `SELECT DISTINCT description AS t FROM properties WHERE status = 'PUBLISHED' AND description IS NOT NULL` },
  { what: 'house rules', sql: `SELECT DISTINCT extra_rules AS t FROM house_rules WHERE extra_rules IS NOT NULL` },
  { what: 'review body', sql: `SELECT DISTINCT body AS t FROM reviews WHERE status = 'PUBLISHED' AND body IS NOT NULL` },
  { what: 'review reply', sql: `SELECT DISTINCT body AS t FROM review_responses WHERE body IS NOT NULL` },
  { what: 'host bio', sql: `SELECT DISTINCT about AS t FROM host_profiles WHERE about IS NOT NULL` },
  { what: 'guide headline', sql: `SELECT DISTINCT headline AS t FROM guide_profiles WHERE status = 'PUBLISHED' AND headline IS NOT NULL` },
  { what: 'guide bio', sql: `SELECT DISTINCT bio AS t FROM guide_profiles WHERE status = 'PUBLISHED' AND bio IS NOT NULL` },
];

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 });

const locales = (arg('--locale') ? [arg('--locale')!] : SUPPORTED_LOCALES.filter((l) => l !== SOURCE_LOCALE)).filter(
  (l): l is string => SUPPORTED_LOCALES.includes(l as any) && l !== SOURCE_LOCALE,
);
if (!locales.length) {
  console.error(`--locale must be one of ${SUPPORTED_LOCALES.filter((l) => l !== SOURCE_LOCALE).join(', ')}`);
  process.exit(2);
}

const texts = new Map<string, string>(); // hash -> source
for (const s of SOURCES) {
  const rows = await pool.query(s.sql);
  let n = 0;
  for (const r of rows.rows) {
    if (!translatable(r.t)) continue;
    texts.set(sourceHash(r.t), r.t);
    n++;
  }
  console.log(`${String(n).padStart(5)}  ${s.what}`);
}
console.log(`\n${texts.size} distinct strings · ${locales.length} locale(s): ${locales.join(', ')}`);

if (!config.ANTHROPIC_API_KEY && !dryRun) {
  console.error('\nANTHROPIC_API_KEY is not set — nothing to translate with. Re-run with --dry-run to just count.');
  await pool.end();
  process.exit(1);
}

let written = 0;
for (const locale of locales) {
  const have = await pool.query(`SELECT source_hash FROM content_translations WHERE target_locale = $1 AND source_hash = ANY($2::char(64)[])`, [
    locale,
    [...texts.keys()],
  ]);
  const cached = new Set(have.rows.map((r) => r.source_hash));
  const todo = [...texts].filter(([h]) => !cached.has(h)).map(([, t]) => t);
  console.log(`\n${locale}: ${cached.size} cached, ${todo.length} to translate`);
  if (dryRun || !todo.length) continue;

  const translator = new ClaudeTranslator(config.ANTHROPIC_API_KEY!, config.AI_MODEL);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const out = await translator.translate(batch, locale);
      const n = await storeTranslations(pool, batch.map((source, j) => ({ source, translated: out[j] ?? '' })), locale, translator.provider, translator.model);
      written += n;
      process.stdout.write(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}\r`);
    } catch (e) {
      // One bad batch must not lose the rest: report and keep going.
      console.error(`\n  batch ${i}-${i + batch.length} failed: ${(e as Error).message}`);
    }
  }
  console.log('');
}

console.log(`\n${dryRun ? 'dry run — nothing written' : `wrote ${written} translation(s)`}`);
await pool.end();
