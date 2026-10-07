/** Minimal SSE (text/event-stream) parser usable with fetch streams (EventSource cannot send Bearer headers). */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buf = '';
  private ev: Partial<SseEvent> & { dataLines: string[] } = { dataLines: [] };
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buf.search(/\r?\n/)) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + (this.buf[idx] === '\r' ? 2 : 1));
      if (line === '') {
        if (this.ev.dataLines.length) out.push({ event: this.ev.event || 'message', data: this.ev.dataLines.join('\n'), id: this.ev.id });
        this.ev = { dataLines: [] };
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? '' : line.slice(c + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.ev.dataLines.push(value);
      else if (field === 'event') this.ev.event = value;
      else if (field === 'id') this.ev.id = value;
    }
    return out;
  }
}
