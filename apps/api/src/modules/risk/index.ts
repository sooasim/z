import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { idParams, pagination } from '../../platform/http.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { registerRiskConsumers } from './consumers.js';
import * as svc from './service.js';

const TAG = ['PLAT-05'];

const riskType = z.string().trim().toUpperCase().regex(svc.RISK_TYPE_RE, 'UPPER_SNAKE risk type');
const note = z.string().trim().min(1).max(2000);

const incidentEventBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NOTE'), note: z.string().trim().min(1).max(10_000) }),
  z.object({
    type: z.literal('STATUS_CHANGE'),
    status: z.enum(svc.INCIDENT_STATUSES),
    note: note.optional(),
    postmortemUrl: z.url({ protocol: /^https$/ }).max(2000).optional(),
  }),
  z.object({ type: z.literal('SEVERITY_CHANGE'), severity: z.enum(svc.INCIDENT_SEVERITIES), note: note.optional() }),
  z.object({ type: z.literal('COMMANDER_CHANGE'), commanderId: z.uuid(), note: note.optional() }),
  z.object({ type: z.literal('RISK_LINKED'), riskEventIds: z.array(z.uuid()).min(1).max(100), note: note.optional() }),
]);

/** PLAT-05 Security / Risk: risk event triage, risk scores, security incident response (staff, AAL2). */
export default async function riskModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  // ADMIN / COMPLIANCE / SUPPORT — all staff roles, so AAL2 (MFA) is enforced by requireRole
  const responders = requireRole('ADMIN', 'COMPLIANCE', 'SUPPORT');

  registerRiskConsumers();

  // ---- risk events -------------------------------------------------------------------------------------------
  r.get('/v1/admin/risk/events', {
    schema: {
      tags: TAG,
      summary: 'List risk events (newest first, keyset pagination)',
      querystring: pagination.extend({
        subjectType: z.enum(svc.SUBJECT_TYPES).optional(),
        subjectId: z.string().trim().min(1).max(200).optional(),
        riskType: riskType.optional(),
        severity: z.enum(svc.SEVERITIES).optional(),
        status: z.enum(svc.RISK_STATUSES).optional(),
        since: z.iso.datetime({ offset: true }).optional(),
      }),
    },
    preHandler: responders,
  }, async (req) => svc.listRiskEvents(pool, req.query));

  r.post('/v1/admin/risk/events', {
    schema: {
      tags: TAG,
      summary: 'Flag a subject manually (risk type MANUAL unless given)',
      body: z.object({
        subjectType: z.enum(svc.SUBJECT_TYPES),
        subjectId: z.string().trim().min(1).max(200),
        riskType: riskType.optional(),
        severity: z.enum(svc.SEVERITIES),
        score: z.number().int().min(0).max(100).optional(),
        reason: z.string().trim().min(3).max(2000),
        detail: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    preHandler: responders,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const res = await withIdempotency(pool, `risk.flag:${ctx.actor!.userId}`, idempotencyKeyFrom(req, false), req.body, async (tx) => ({
      status: 201,
      body: { item: await svc.flagRiskManually(tx, ctx, req.body) },
    }));
    return reply.status(res.status).send(res.body);
  });

  r.get('/v1/admin/risk/events/:id', { schema: { tags: TAG, params: idParams }, preHandler: responders }, async (req) => ({
    item: await svc.getRiskEvent(pool, req.params.id),
  }));

  r.post('/v1/admin/risk/events/:id/status', {
    schema: {
      tags: TAG,
      summary: 'Triage a risk event (ACKNOWLEDGED / RESOLVED / FALSE_POSITIVE / reopen)',
      params: idParams,
      body: z.object({ status: z.enum(svc.RISK_STATUSES), note: note.optional() }),
    },
    preHandler: responders,
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => svc.changeRiskStatus(tx, ctx, req.params.id, req.body)) };
  });

  r.get('/v1/admin/risk/score', {
    schema: {
      tags: TAG,
      summary: 'Aggregated risk score of a subject over a window',
      querystring: z.object({
        subjectType: z.enum(svc.SUBJECT_TYPES),
        subjectId: z.string().trim().min(1).max(200),
        windowMinutes: z.coerce.number().int().min(1).max(60 * 24 * 90).default(60),
      }),
    },
    preHandler: responders,
  }, async (req) => ({ item: await svc.riskSummary(pool, req.query.subjectType, req.query.subjectId, req.query.windowMinutes) }));

  // ---- security incidents ------------------------------------------------------------------------------------
  r.post('/v1/admin/security/incidents', {
    schema: {
      tags: TAG,
      summary: 'Open a security incident (Idempotency-Key supported)',
      body: z.object({
        title: z.string().trim().min(3).max(200),
        severity: z.enum(svc.INCIDENT_SEVERITIES),
        summary: z.string().trim().max(10_000).optional(),
        commanderId: z.uuid().optional(),
        relatedRiskEventIds: z.array(z.uuid()).max(100).optional(),
      }),
    },
    preHandler: responders,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const res = await withIdempotency(pool, `security.incident.open:${ctx.actor!.userId}`, idempotencyKeyFrom(req, false), req.body, async (tx) => ({
      status: 201,
      body: { item: await svc.openIncident(tx, ctx, req.body) },
    }));
    return reply.status(res.status).send(res.body);
  });

  r.get('/v1/admin/security/incidents', {
    schema: {
      tags: TAG,
      querystring: pagination.extend({
        status: z.enum(svc.INCIDENT_STATUSES).optional(),
        severity: z.enum(svc.INCIDENT_SEVERITIES).optional(),
        active: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
      }),
    },
    preHandler: responders,
  }, async (req) => svc.listIncidents(pool, req.query));

  r.get('/v1/admin/security/incidents/:id', { schema: { tags: TAG, params: idParams }, preHandler: responders }, async (req) =>
    svc.getIncident(pool, req.params.id),
  );

  r.post('/v1/admin/security/incidents/:id/events', {
    schema: {
      tags: TAG,
      summary: 'Append to the incident timeline (note, status/severity/commander change, link risk events)',
      params: idParams,
      body: incidentEventBody,
    },
    preHandler: responders,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const res = await withTx(pool, (tx) => svc.addIncidentEvent(tx, ctx, req.params.id, req.body as svc.IncidentEventInput));
    return reply.status(201).send(res);
  });
}
