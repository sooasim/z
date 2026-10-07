// Container HEALTHCHECK for jetpool-api: probes /health for the api role; other roles
// (worker, migrate) are considered healthy while the process is running.
import { readFileSync } from 'node:fs';
let role = 'api';
try { role = readFileSync('/tmp/jetpool-role', 'utf8').trim() || 'api'; } catch {}
if (role !== 'api') process.exit(0);
const url = process.env.HEALTHCHECK_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}/health`;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
