import type { AppContext } from './context.js';
import { sourceHash, storeTranslations, translatable, type Translator } from './translate.js';

/**
 * Background filler for the translation cache.
 *
 * A read never blocks on the model (see platform/translate.ts), so misses land here instead. The queue is
 * deliberately small and in-process:
 *   * one pending set per target locale, de-duplicated by source hash, so a hundred readers hitting the same
 *     uncached listing cost one request;
 *   * a cap on queued strings, because an unbounded queue in front of a paid API is a bill, not a feature —
 *     past the cap new misses are dropped and simply retried by the next reader;
 *   * one request in flight at a time, batched, with failures swallowed after a log. A failed translation
 *     means readers keep seeing the source text, which is the same outcome as not having the feature.
 *
 * It is intentionally not durable. Nothing is lost on restart: the entries are a cache of work that any later
 * read will queue again.
 */
const MAX_PENDING = 500;
const BATCH = 25;

export class TranslationQueue {
  private pending = new Map<string, Map<string, string>>(); // locale -> hash -> source
  private running = false;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly app: Pick<AppContext, 'pool' | 'log'>,
    private readonly translator: Translator,
  ) {}

  /** Queue sources for translation. Returns immediately. */
  add(texts: readonly string[], targetLocale: string): void {
    let bucket = this.pending.get(targetLocale);
    if (!bucket) {
      bucket = new Map();
      this.pending.set(targetLocale, bucket);
    }
    for (const t of texts) {
      if (!translatable(t)) continue;
      if (this.size >= MAX_PENDING) break;
      bucket.set(sourceHash(t), t);
    }
    void this.run();
  }

  get size(): number {
    let n = 0;
    for (const b of this.pending.values()) n += b.size;
    return n;
  }

  /** Drain the queue. Exposed so tests (and a shutdown hook) can await the work instead of sleeping. */
  async drain(): Promise<void> {
    while (this.size || this.inflight) await this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return this.inflight ?? undefined;
    this.running = true;
    this.inflight = this.loop().finally(() => {
      this.running = false;
      this.inflight = null;
    });
    return this.inflight;
  }

  private async loop(): Promise<void> {
    for (;;) {
      const next = this.take();
      if (!next) return;
      const { locale, batch } = next;
      try {
        const translated = await this.translator.translate(batch, locale);
        const entries = batch.map((source, i) => ({ source, translated: translated[i] ?? '' }));
        const written = await storeTranslations(this.app.pool, entries, locale, this.translator.provider, this.translator.model);
        this.app.log?.debug?.({ locale, requested: batch.length, written }, 'content translated');
      } catch (e) {
        // Readers keep seeing the source text; the next read re-queues. Never surface this to a request.
        this.app.log?.warn?.({ err: e, locale, count: batch.length }, 'content translation failed');
      }
    }
  }

  private take(): { locale: string; batch: string[] } | null {
    for (const [locale, bucket] of this.pending) {
      if (!bucket.size) {
        this.pending.delete(locale);
        continue;
      }
      const batch: string[] = [];
      for (const [hash, source] of bucket) {
        batch.push(source);
        bucket.delete(hash);
        if (batch.length >= BATCH) break;
      }
      return { locale, batch };
    }
    return null;
  }
}
