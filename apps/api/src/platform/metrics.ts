import client from 'prom-client';

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
