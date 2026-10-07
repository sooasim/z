import { EventEmitter } from 'node:events';

/**
 * Realtime delivery is a non-authoritative delivery aid (invariant 1). Messages are persisted in Postgres
 * first, then published here. Single-process EventEmitter; multi-instance deployments bridge via
 * Postgres LISTEN/NOTIFY (see modules/messaging) or Supabase Realtime.
 */
export class Realtime {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(channel: string, payload: unknown) {
    this.emitter.emit(channel, payload);
  }
  subscribe(channel: string, fn: (payload: any) => void): () => void {
    this.emitter.on(channel, fn);
    return () => this.emitter.off(channel, fn);
  }
}
