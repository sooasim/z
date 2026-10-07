'use client';
import { API_URL } from './env';
import { getAccessToken, refreshAccessToken } from './token';
import { SseParser, type SseEvent } from './sse';

/**
 * Subscribe to `/v1/realtime/stream` (SSE). Realtime is a delivery aid only — screens must still reload
 * authoritative state from the REST API. Reconnects with backoff; returns an unsubscribe fn.
 */
export function subscribeRealtime(onEvent: (e: SseEvent & { json?: any }) => void, opts: { channels?: string[] } = {}): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  let attempt = 0;

  const run = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        let token = getAccessToken() || (await refreshAccessToken());
        if (!token) throw new Error('no token');
        const url = new URL(API_URL + '/v1/realtime/stream');
        opts.channels?.forEach((c) => url.searchParams.append('channel', c));
        let res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) {
          token = await refreshAccessToken();
          if (!token) throw new Error('unauthenticated');
          res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ctrl.signal, cache: 'no-store' });
        }
        if (!res.ok || !res.body) throw new Error('stream ' + res.status);
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of parser.push(value)) {
            let json: any;
            try {
              json = JSON.parse(ev.data);
            } catch {
              /* plain text */
            }
            onEvent({ ...ev, json });
          }
        }
      } catch (e) {
        if (stopped || (e as Error)?.name === 'AbortError') return;
      }
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}
