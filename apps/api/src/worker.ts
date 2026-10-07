import { buildApp } from './app.js';
import { runJobs } from './platform/jobs.js';
import { createMetricsServer, outboxLag, workerMetricsPort } from './platform/metrics.js';

/** Background worker: outbox dispatch + scheduled sweeps (hold expiry, payment expiry, retention, search sync). */
const app = await buildApp();
await app.ready();
const stop = runJobs(app.ctx);

// PLAT-04: the worker has no Fastify listener, so it exposes its own Prometheus endpoint
// (outbox dispatched/failed/dead-lettered counters, payment outcomes, process metrics).
const metricsPort = workerMetricsPort();
const metrics = metricsPort === null
  ? null
  : createMetricsServer({
      beforeScrape: async () => {
        const { rows } = await app.ctx.pool.query(
          `SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL`,
        );
        outboxLag.set(rows[0].n);
      },
      onError: (err) => app.log.warn({ err }, 'worker metrics scrape error'),
    });
if (metrics) {
  metrics.on('error', (err) => app.log.error({ err, port: metricsPort }, 'worker metrics server failed; continuing without it'));
  metrics.listen(metricsPort!, process.env.WORKER_METRICS_HOST ?? app.ctx.config.HOST, () =>
    app.log.info({ port: metricsPort }, 'worker metrics listening'),
  );
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await stop();
    if (metrics?.listening) await new Promise<void>((r) => metrics.close(() => r()));
    await app.close();
    process.exit(0);
  });
}
