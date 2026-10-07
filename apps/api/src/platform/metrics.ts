import client from 'prom-client';
import http from 'node:http';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'jetpool_' });

export const httpDuration = new client.Histogram({
  name: 'jetpool_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const domainCounter = new client.Counter({
  name: 'jetpool_domain_events_total',
  help: 'Domain events by type',
  labelNames: ['event_type'],
  registers: [registry],
});

export const outboxLag = new client.Gauge({
  name: 'jetpool_outbox_pending',
  help: 'Unpublished outbox events',
  registers: [registry],
});

// ------------------------------------------------------------------------------------------------ worker (PLAT-03/PLAT-04)

/** Outbox events published after every matching consumer succeeded (incremented after the dispatch tx commits). */
export const outboxDispatched = new client.Counter({
  name: 'jetpool_outbox_dispatched_total',
  help: 'Outbox events dispatched successfully, by event type',
  labelNames: ['event_type'],
  registers: [registry],
});

/** Consumer (handler) failures; each failure schedules a retry with exponential backoff. */
export const outboxFailed = new client.Counter({
  name: 'jetpool_outbox_failed_total',
  help: 'Outbox consumer failures, by consumer',
  labelNames: ['consumer'],
  registers: [registry],
});

/** Events that exhausted their retries and moved to the dead-letter view (`dead_letters`). */
export const outboxDeadLettered = new client.Counter({
  name: 'jetpool_outbox_dead_lettered_total',
  help: 'Outbox events moved to the dead-letter queue',
  registers: [registry],
});

export const paymentOutcomes = new client.Counter({
  name: 'jetpool_payment_outcomes_total',
  help: 'Payment outcomes (provider-confirmed), by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

export type PaymentOutcome =
  | 'approved'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'mismatch'
  | 'refunded'
  | 'partially_refunded'
  | 'refund_failed';

/** Normalize a label value: lowercase [a-z0-9_], ≤40 chars; anything else is bucketed as 'other' (bounded cardinality). */
function boundedLabel(v: string): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z][a-z0-9_]{0,39}$/.test(s) ? s : 'other';
}

/**
 * PAY-0x / PLAT-04: count a payment outcome. Call it once per terminal outcome AFTER the provider confirmation
 * (or failure) has been persisted, e.g. `recordPaymentOutcome('approved')`.
 */
export function recordPaymentOutcome(outcome: PaymentOutcome | (string & {}), n = 1): void {
  if (!(n > 0)) return;
  paymentOutcomes.inc({ outcome: boundedLabel(outcome) }, n);
}

/** WORKER_METRICS_PORT: unset → 9464; 'off' / 'false' / 'disabled' / negative → disabled (null). */
export function workerMetricsPort(raw: string | undefined = process.env.WORKER_METRICS_PORT): number | null {
  if (raw === undefined || raw.trim() === '') return 9464;
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === 'disabled') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}

/**
 * Minimal Prometheus scrape endpoint for processes without the Fastify API (the worker):
 * GET /metrics (text exposition), GET /health. `beforeScrape` refreshes gauges (e.g. outbox backlog); its
 * failure never fails the scrape.
 */
export function createMetricsServer(opts: { beforeScrape?: () => Promise<void>; onError?: (err: unknown) => void } = {}): http.Server {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      if (path === '/metrics') {
        if (opts.beforeScrape) await opts.beforeScrape().catch((err) => opts.onError?.(err));
        const body = await registry.metrics();
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(req.method === 'HEAD' ? undefined : body);
      } else if (path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 404 }));
      }
    } catch (err) {
      opts.onError?.(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
