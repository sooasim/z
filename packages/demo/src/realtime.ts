/** Fake `/v1/realtime/stream` (SSE over fetch) and EventSource: delivers events created locally in the demo. */
const enc = new TextEncoder();
const subs = new Set<{ userId: string; ctrl: ReadableStreamDefaultController<Uint8Array> }>();

export function realtimeResponse(userId: string, signal?: AbortSignal | null): Response {
  let entry: { userId: string; ctrl: ReadableStreamDefaultController<Uint8Array> } | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      entry = { userId, ctrl };
      subs.add(entry);
      ctrl.enqueue(enc.encode(': JETPOOL static demo — realtime replays local activity only\n\n'));
      signal?.addEventListener('abort', () => {
        if (entry) subs.delete(entry);
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (entry) subs.delete(entry);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}

export function publish(userIds: string[], event: string, data: unknown) {
  const frame = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const s of subs) {
    if (!userIds.includes(s.userId)) continue;
    try {
      s.ctrl.enqueue(frame);
    } catch {
      subs.delete(s);
    }
  }
  for (const es of fakeSources) if (userIds.includes(es.userId) || es.userId === '*') es.emit(event, data);
}

const fakeSources = new Set<FakeEventSource>();
/** Minimal EventSource stand-in for demo API URLs (the web uses fetch streams, but keep EventSource safe too). */
export class FakeEventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  url: string;
  withCredentials = false;
  userId = '*';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string) {
    super();
    this.url = url;
    fakeSources.add(this);
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      const e = new Event('open');
      this.onopen?.(e);
      this.dispatchEvent(e);
    }, 0);
  }
  emit(event: string, data: unknown) {
    if (this.readyState !== 1) return;
    const e = new MessageEvent(event, { data: JSON.stringify(data) });
    if (event === 'message') this.onmessage?.(e);
    this.dispatchEvent(e);
  }
  close() {
    this.readyState = 2;
    fakeSources.delete(this);
  }
}
