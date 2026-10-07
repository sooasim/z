import type { AppContext } from './context.js';
import { dispatchOutbox } from './outbox.js';

interface Job { name: string; intervalMs: number; run: (app: AppContext) => Promise<unknown> }
const jobs: Job[] = [];

/** Modules register periodic sweeps here (hold expiry, payment expiry, search sync, retention...). */
export function registerJob(name: string, intervalMs: number, run: (app: AppContext) => Promise<unknown>) {
  if (!jobs.some((j) => j.name === name)) jobs.push({ name, intervalMs, run });
}
export const registeredJobs = () => [...jobs];

/** Run every registered job once (tests, cron-style invocations). */
export async function runAllJobsOnce(app: AppContext) {
  for (const j of jobs) await j.run(app);
}

export function runJobs(app: AppContext): () => Promise<void> {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const loop = async (name: string, ms: number, fn: () => Promise<unknown>) => {
    if (stopped) return;
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      app.log.error({ err, job: name }, 'job failed');
    }
    if (!stopped) timers.push(setTimeout(() => loop(name, ms, fn), Math.max(0, ms - (Date.now() - started))));
  };
  loop('outbox', app.config.OUTBOX_POLL_MS, async () => {
    while ((await dispatchOutbox(app)) > 0 && !stopped) {}
  });
  for (const j of jobs) loop(j.name, j.intervalMs, () => j.run(app));
  return async () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };
}
