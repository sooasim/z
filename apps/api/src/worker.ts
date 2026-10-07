import { buildApp } from './app.js';
import { runJobs } from './platform/jobs.js';

/** Background worker: outbox dispatch + scheduled sweeps (hold expiry, payment expiry, retention, search sync). */
const app = await buildApp();
await app.ready();
const stop = runJobs(app.ctx);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await stop();
    await app.close();
    process.exit(0);
  });
}
