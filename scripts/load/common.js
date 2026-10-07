// Shared k6 helpers. Profiles: K6_PROFILE=smoke (1 VU, 30s) | load (ramp to K6_VUS, default 50).
export const BASE = (__ENV.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
export const REPORT_DIR = __ENV.REPORT_DIR || 'reports';

export function profile(p95ms) {
  const smoke = (__ENV.K6_PROFILE || 'load') === 'smoke';
  const vus = Number(__ENV.K6_VUS || 50);
  return {
    scenarios: smoke
      ? { smoke: { executor: 'constant-vus', vus: 1, duration: '30s' } }
      : { load: { executor: 'ramping-vus', startVUs: 1, stages: [
          { duration: '30s', target: Math.ceil(vus / 2) }, { duration: '1m', target: vus }, { duration: '30s', target: 0 }] } },
    thresholds: {
      http_req_failed: ['rate<0.01'],
      http_req_duration: [`p(95)<${p95ms}`],
    },
  };
}

export function summary(name, data) {
  const out = {};
  out[`${REPORT_DIR}/k6-${name}.json`] = JSON.stringify(data, null, 2);
  const d = data.metrics.http_req_duration?.values ?? {};
  out.stdout = `\n[k6 ${name}] reqs=${data.metrics.http_reqs?.values?.count ?? 0} p95=${Math.round(d['p(95)'] ?? 0)}ms failed=${((data.metrics.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)}%\n`;
  return out;
}

export function loadFixture() {
  return __ENV.FIXTURE ? JSON.parse(open(__ENV.FIXTURE)) : null;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function isoDay(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
}
