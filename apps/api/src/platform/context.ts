import type pg from 'pg';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Actor } from './auth.js';
import type { Realtime } from './realtime.js';
import type { Logger } from 'pino';

/** Process-wide dependencies. Adapters (payments, storage, search, ...) are registered by modules. */
export interface AppContext {
  config: Config;
  pool: pg.Pool;
  realtime: Realtime;
  log: Logger;
  /** Named adapter registry (e.g. 'payments.provider', 'storage', 'search', 'geocoder', 'notifier'). */
  adapters: Map<string, unknown>;
}

/** Per-request (or per-job) context passed into domain services. */
export interface Ctx {
  app: AppContext;
  actor: Actor | null;
  correlationId: string;
  ip?: string;
  userAgent?: string;
}

export function ctxFromRequest(req: FastifyRequest): Ctx {
  return {
    app: req.server.ctx,
    actor: req.actor ?? null,
    correlationId: req.correlationId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

export function systemCtx(app: AppContext, correlationId: string): Ctx {
  return { app, actor: null, correlationId };
}

export function getAdapter<T>(app: AppContext, name: string): T {
  const a = app.adapters.get(name);
  if (!a) throw new Error(`adapter '${name}' is not registered`);
  return a as T;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    actor: Actor | null;
    correlationId: string;
  }
}
