import type { Translator } from '../../platform/translate.js';

/**
 * LibreTranslate-backed translation — the open-source, self-hostable alternative to the Claude adapter
 * (https://github.com/LibreTranslate/LibreTranslate, AGPL-3.0, built on Argos Translate).
 *
 * It exists so auto-translation works with no API key and no per-call cost: `docker compose up libretranslate`
 * and every member-written string on the site is translated by a service the operator runs themselves. The
 * trade-off against Claude is quality, so `TRANSLATE_PROVIDER=AUTO` prefers Claude when a key is configured.
 *
 * JETPOOL speaks BCP-47 (`ja-JP`); LibreTranslate speaks ISO 639-1 (`ja`). The map below is the whole of that
 * translation, and an unmapped locale throws rather than silently asking for the wrong language.
 *
 * Two safety rules match the Claude adapter, for the same reasons:
 *   * a response whose length does not match the request is rejected outright — a misaligned array would
 *     attach one member's text to another member's message;
 *   * the request is chunked, because a server started with `--batch-limit` rejects an oversized batch and we
 *     would rather send three requests than lose the batch.
 */

/** BCP-47 → the ISO 639-1 code LibreTranslate expects. */
const LANGUAGE_CODE: Record<string, string> = {
  'ko-KR': 'ko',
  'en-US': 'en',
  'ja-JP': 'ja',
  'zh-CN': 'zh',
  'vi-VN': 'vi',
};

/** Keep below the default `--batch-limit` of a self-hosted instance. */
const MAX_BATCH = 20;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LibreTranslatorOptions {
  apiKey?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class LibreTranslator implements Translator {
  readonly provider = 'libretranslate';
  /** LibreTranslate serves Argos models; it reports no per-request model name. */
  readonly model = 'argos';
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: LibreTranslatorOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async translate(texts: string[], targetLocale: string): Promise<string[]> {
    if (!texts.length) return [];
    const target = LANGUAGE_CODE[targetLocale];
    if (!target) throw new Error(`unsupported target locale ${targetLocale}`);
    const out: string[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      out.push(...(await this.translateBatch(texts.slice(i, i + MAX_BATCH), target)));
    }
    return out;
  }

  private async translateBatch(batch: string[], target: string): Promise<string[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // `source: 'auto'` so a Vietnamese traveller writing to a Korean host is detected per message —
        // this adapter translates both directions of a conversation, not just from the catalogue language.
        body: JSON.stringify({ q: batch, source: 'auto', target, format: 'text', ...(this.apiKey ? { api_key: this.apiKey } : {}) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`libretranslate ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { translatedText?: unknown };
    const raw = body?.translatedText;
    // An array in gives an array out, but a single-element batch comes back as a bare string on some versions.
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' && batch.length === 1 ? [raw] : null;
    if (!list || list.length !== batch.length || list.some((x) => typeof x !== 'string')) {
      throw new Error(`libretranslate returned ${Array.isArray(raw) ? raw.length : typeof raw} for ${batch.length} inputs`);
    }
    return list as string[];
  }
}
