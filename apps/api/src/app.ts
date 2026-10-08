import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import pino from 'pino';
import { z } from 'zod';
import { loadConfig, type Config } from './platform/config.js';
import { createPool } from './platform/db.js';
import { AppError, fromPgError } from './platform/errors.js';
import { resolveActor } from './platform/auth.js';
import { Realtime } from './platform/realtime.js';
import type { AppContext } from './platform/context.js';
import { httpDuration, registry, outboxLag } from './platform/metrics.js';
import { redactSecretsInText, serializeRequest } from './platform/http.js';
import { registerModules } from './modules/index.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-toss-signature"]',
  '*.password',
  '*.newPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.code',
  '*.secret',
  '*.cardNumber',
  '*.cvc',
];

export interface BuildOptions {
  config?: Partial<Config>;
  logger?: boolean;
  /** Log destination (default stdout). Tests pass a capture stream to assert on redaction. */
  logStream?: pino.DestinationStream;
}

/** Error serializer: pino's standard one, with secret query parameters scrubbed from message/stack (e.g. FST_ERR_* carry the URL). */
function serializeError(err: any) {
  const out: any = pino.stdSerializers.err(err);
  if (out && typeof out === 'object') {
    if (typeof out.message === 'string') out.message = redactSecretsInText(out.message);
    if (typeof out.stack === 'string') out.stack = redactSecretsInText(out.stack);
  }
  return out;
}

/**
 * Root logger. Secrets never reach the log sink: header/body paths are redacted (REDACT_PATHS), the request
 * serializer strips token/code/state/access_token/refresh_token/paymentKey query values from URLs (SSE and iCal
 * feeds authenticate with ?token=), and string messages are scrubbed the same way (Fastify's "Route GET:/x?token=… not found").
 */
export function createLogger(level: string, stream?: pino.DestinationStream) {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { req: serializeRequest, err: serializeError },
      hooks: {
        logMethod(args: any[], method: (...a: any[]) => void) {
          for (let i = 0; i < args.length; i++) if (typeof args[i] === 'string') args[i] = redactSecretsInText(args[i]);
          return method.apply(this, args);
        },
      },
    },
    stream,
  );
}

/** config.TRUST_PROXY → Fastify trustProxy: 'true'/'false', a hop count, or a comma-separated address/CIDR list. */
export function trustProxySetting(v: string): boolean | string | ((address: string, hop: number) => boolean) {
  const s = v.trim();
  if (s === 'true') return true;
  if (s === 'false' || s === '') return false;
  if (/^\d+$/.test(s)) {
    const hops = Number(s);
    return (_address: string, hop: number) => hop < hops;
  }
  return s;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(opts.config as any);
  const log = createLogger(opts.logger === false ? 'silent' : config.LOG_LEVEL, opts.logStream);
  const app = Fastify({
    loggerInstance: log as unknown as import("fastify").FastifyBaseLogger,
    // never `true`: that makes req.ip the left-most (client-chosen) X-Forwarded-For value (rate limits, audit IPs)
    trustProxy: trustProxySetting(config.TRUST_PROXY),
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => (req.headers['x-correlation-id'] as string) || randomUUID(),
  });

  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const ctx: AppContext = { config, pool, realtime: new Realtime(), log, adapters: new Map() };
  app.decorate('ctx', ctx);
  app.decorateRequest('actor', null);
  app.decorateRequest('correlationId', '');
  app.addHook('onClose', async () => {
    await pool.end();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-correlation-id'],
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health' || req.url === '/ready',
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'JETPOOL API', version: '2.0.0', description: 'JETPOOL commercial platform API (generated from route schemas)' },
      servers: [{ url: config.PUBLIC_API_URL }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  if (config.NODE_ENV !== 'production') await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (req, reply) => {
    req.correlationId = String(req.id);
    reply.header('x-correlation-id', req.correlationId);
    (req as any)._start = process.hrtime.bigint();
  });
  app.addHook('preHandler', async (req) => {
    req.actor = await resolveActor(config, pool, req.headers.authorization);
  });
  app.addHook('onResponse', async (req, reply) => {
    const start = (req as any)._start as bigint | undefined;
    if (start) {
      httpDuration.observe(
        { method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: String(reply.statusCode) },
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    let problem: AppError | null = null;
    if (err instanceof AppError) problem = err;
    else if (hasZodFastifySchemaValidationErrors(err)) {
      problem = new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', err.validation);
    } else if (err?.validation) {
      problem = new AppError(400, 'VALIDATION_FAILED', err.message, err.validation);
    } else if (err?.statusCode === 429) {
      problem = new AppError(429, 'RATE_LIMITED', 'Too many requests');
    } else if (err?.statusCode && err.statusCode < 500) {
      problem = new AppError(err.statusCode, err.code ?? 'BAD_REQUEST', err.message);
    } else {
      problem = fromPgError(err);
    }
    if (!problem || problem.status >= 500) {
      req.log.error({ err }, 'unhandled error');
      problem = problem ?? new AppError(500, 'INTERNAL', 'Internal server error');
    }
    reply
      .status(problem.status)
      .type('application/problem+json')
      .send({
        type: `https://docs.jetpool.kr/problems/${problem.code.toLowerCase()}`,
        title: problem.message,
        status: problem.status,
        code: problem.code,
        details: problem.details,
        correlationId: req.correlationId,
      });
  });

  // PLAT-04 observability endpoints. /health and /ready stay in the generated OpenAPI (hide would drop the tag);
  // /metrics is hidden from the public contract but tagged for traceability.
  app.get('/health', {
    schema: { tags: ['PLAT-04'], summary: 'Liveness probe', security: [], response: { 200: z.object({ status: z.literal('ok') }) } },
  }, async () => ({ status: 'ok' as const }));
  app.get('/ready', {
    schema: {
      tags: ['PLAT-04'],
      summary: 'Readiness probe (database reachable; reports unpublished outbox backlog)',
      security: [],
      response: {
        200: z.object({ status: z.literal('ready'), outboxPending: z.number().int() }),
        503: z.object({ status: z.literal('unavailable') }),
      },
    },
  }, async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL`);
      outboxLag.set(rows[0].n);
      return { status: 'ready' as const, outboxPending: rows[0].n as number };
    } catch {
      return reply.status(503).send({ status: 'unavailable' as const });
    }
  });
  app.get('/metrics', { schema: { hide: true, tags: ['PLAT-04'] } }, async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  await registerModules(app);
  return app;
}
