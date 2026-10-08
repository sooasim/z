import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { Agent, EnvHttpProxyAgent, fetch } from 'undici';
import { sleep } from './util.mjs';

export const DEFAULT_USER_AGENT = 'JETPOOL-Migration/1.0 (+owner-authorised)';
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_ERRORS = new Set(['TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED', 'NETWORK_ERROR']);

class FetchError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

function errorCode(err) {
  if (err instanceof FetchError) return err.code;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'TIMEOUT';
  const c = err?.cause?.code ?? err?.code;
  if (c) return String(c);
  return 'NETWORK_ERROR';
}

function retryAfterMs(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

/**
 * Polite HTTP client for the migration: global concurrency cap, minimum delay between request starts per host
 * (raised by robots.txt Crawl-delay), retries with exponential backoff (+Retry-After), manual redirects where every
 * hop is re-checked against the allowlist/robots, total + idle timeouts and byte caps. Honours HTTP(S)_PROXY /
 * NO_PROXY via undici's EnvHttpProxyAgent (set NODE_EXTRA_CA_CERTS for an intercepting proxy CA).
 */
export class Fetcher {
  constructor({
    userAgent = DEFAULT_USER_AGENT,
    concurrency = 2,
    delayMs = 500,
    timeoutMs = 30_000,
    retries = 3,
    retryBaseMs = 1000,
    maxRetryWaitMs = 60_000,
    maxRedirects = 5,
    useProxy = true,
    log,
  } = {}) {
    Object.assign(this, { userAgent, concurrency, delayMs, timeoutMs, retries, retryBaseMs, maxRetryWaitMs, maxRedirects, log });
    const agentOpts = { headersTimeout: timeoutMs, bodyTimeout: Math.max(timeoutMs, 60_000), connectTimeout: Math.min(timeoutMs, 30_000) };
    this.dispatcher = useProxy ? new EnvHttpProxyAgent(agentOpts) : new Agent(agentOpts);
    this.active = 0;
    this.waiters = [];
    this.nextAt = new Map();
    this.hostDelay = new Map();
    this.stats = { requests: 0, retries: 0, bytes: 0, byHost: {} };
  }

  /** robots.txt Crawl-delay (ms) for a host; never below the configured delay, capped at 30 s. */
  setHostDelay(host, ms) {
    this.hostDelay.set(host, Math.min(Math.max(ms, this.delayMs), 30_000));
  }

  async #acquire() {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
    this.active++;
  }

  #release() {
    this.active--;
    const w = this.waiters.shift();
    if (w) w();
  }

  /** Reserve the next start slot for `host` synchronously, then wait for it. */
  async #turn(host) {
    const delay = this.hostDelay.get(host) ?? this.delayMs;
    const now = Date.now();
    const at = Math.max(now, this.nextAt.get(host) ?? 0);
    this.nextAt.set(host, at + delay);
    if (at > now) await sleep(at - now);
  }

  /**
   * GET with retries. Never throws for HTTP/network failures: returns { ok:false, error } instead.
   * opts.allowUrl(url) → true | reason string (checked for the first URL and every redirect hop).
   * opts.maxBytes: number | (contentType) => number. opts.toFile: stream body to this path instead of memory.
   */
  async get(url, opts = {}) {
    const attempts = opts.retries ?? this.retries;
    let last;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        last = await this.#once(url, opts);
      } catch (err) {
        const code = errorCode(err);
        last = { ok: false, status: 0, url, error: code, message: String(err?.message ?? err).slice(0, 300) };
        if (opts.toFile) await rm(opts.toFile, { force: true });
        if (!RETRY_ERRORS.has(code) || attempt === attempts) return { ...last, attempts: attempt + 1 };
        await this.#backoff(attempt, null, url, code);
        continue;
      }
      if (!last.ok && RETRY_STATUS.has(last.status) && attempt < attempts) {
        if (opts.toFile) await rm(opts.toFile, { force: true });
        await this.#backoff(attempt, last.retryAfter, url, `HTTP ${last.status}`);
        continue;
      }
      return { ...last, attempts: attempt + 1 };
    }
    return { ...last, attempts: attempts + 1 };
  }

  async #backoff(attempt, retryAfter, url, why) {
    this.stats.retries++;
    const exp = this.retryBaseMs * 2 ** attempt;
    const wait = Math.min(this.maxRetryWaitMs, Math.max(retryAfter ?? 0, exp + Math.floor(Math.random() * this.retryBaseMs * 0.25)));
    this.log?.warn(`retry ${attempt + 1} for ${url} after ${why} (waiting ${wait} ms)`);
    await sleep(wait);
  }

  async #once(url, opts) {
    const redirects = [];
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const allowed = opts.allowUrl ? await opts.allowUrl(current) : true;
      if (allowed !== true) return { ok: false, status: 0, url: current, redirects, error: typeof allowed === 'string' ? allowed : 'URL_NOT_ALLOWED' };
      const host = new URL(current).host;
      await this.#acquire();
      try {
        await this.#turn(host);
        this.stats.requests++;
        this.stats.byHost[host] = (this.stats.byHost[host] ?? 0) + 1;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new FetchError('TIMEOUT')), opts.timeoutMs ?? this.timeoutMs);
        try {
          const res = await fetch(current, {
            dispatcher: this.dispatcher,
            redirect: 'manual',
            signal: ac.signal,
            headers: {
              'user-agent': this.userAgent,
              accept: opts.accept ?? '*/*',
              'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
            },
          });
          if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            await res.body?.cancel().catch(() => {});
            redirects.push({ url: current, status: res.status });
            current = new URL(res.headers.get('location'), current).toString();
            continue;
          }
          const headers = Object.fromEntries(res.headers.entries());
          const contentType = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          const base = { status: res.status, url: current, redirects, headers, contentType, retryAfter: retryAfterMs(headers['retry-after']) };
          if (res.status < 200 || res.status >= 300) {
            await res.body?.cancel().catch(() => {});
            return { ...base, ok: false, error: `HTTP_${res.status}` };
          }
          const cap = typeof opts.maxBytes === 'function' ? opts.maxBytes(contentType, current) : opts.maxBytes ?? 15 * 1024 * 1024;
          const declared = Number(headers['content-length']);
          if (Number.isFinite(declared) && declared > cap) {
            await res.body?.cancel().catch(() => {});
            return { ...base, ok: false, error: 'TOO_LARGE', bytes: declared, cap };
          }
          const hash = createHash('sha256');
          let bytes = 0;
          let body;
          if (opts.toFile) {
            const ws = createWriteStream(opts.toFile);
            try {
              for await (const chunk of res.body ?? []) {
                bytes += chunk.length;
                if (bytes > cap) throw new FetchError('TOO_LARGE');
                hash.update(chunk);
                if (!ws.write(chunk)) await once(ws, 'drain');
              }
            } catch (err) {
              ws.destroy();
              await rm(opts.toFile, { force: true });
              if (err instanceof FetchError && err.code === 'TOO_LARGE') {
                ac.abort();
                return { ...base, ok: false, error: 'TOO_LARGE', bytes, cap };
              }
              throw err;
            }
            ws.end();
            await once(ws, 'close');
          } else {
            const chunks = [];
            for await (const chunk of res.body ?? []) {
              bytes += chunk.length;
              if (bytes > cap) {
                ac.abort();
                return { ...base, ok: false, error: 'TOO_LARGE', bytes, cap };
              }
              hash.update(chunk);
              chunks.push(chunk);
            }
            body = Buffer.concat(chunks);
          }
          this.stats.bytes += bytes;
          return { ...base, ok: true, body, file: opts.toFile, bytes, sha256: hash.digest('hex') };
        } finally {
          clearTimeout(timer);
        }
      } finally {
        this.#release();
      }
    }
    return { ok: false, status: 0, url: current, redirects, error: 'TOO_MANY_REDIRECTS' };
  }

  async close() {
    await this.dispatcher.close().catch(() => {});
  }
}
