import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireRole, getActor } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx } from '../../platform/context.js';
import { registerJob } from '../../platform/jobs.js';
import { badRequest } from '../../platform/errors.js';
import { isCalendarDate } from '../../platform/http.js';
import {
  approveRule, createRule, decidePermit, evaluateForActor, listPermitQueue, listPermits, listRules, retireRule, runPermitExpiry, submitPermit,
} from './service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(isCalendarDate, 'Not a valid calendar date (YYYY-MM-DD)');
const jurisdiction = z.string().trim().regex(/^(\*|[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?)$/, "e.g. 'KR', 'KR-11' or '*'");
const staff = requireRole('COMPLIANCE', 'ADMIN'); // staff-only → AAL2 enforced

/** STAY-03 Accommodation Compliance Gate — permits, effective-dated approved rules, decisions and expiry sweep. */
export default async function complianceModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const id = z.object({ id: z.uuid() });
  const reasonBody = z.object({ reason: z.string().trim().max(1000).nullish() }).default({});

  r.post('/v1/properties/:id/permits', {
    schema: { summary: 'Register an accommodation permit',
      tags: ['STAY-03'], params: id,
      body: z.object({
        permitType: z.string().trim().min(2).max(80),
        permitNo: z.string().trim().max(120).nullish(),
        jurisdiction,
        documentMediaId: z.uuid().nullish(),
        validFrom: isoDate.nullish(),
        validUntil: isoDate.nullish(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => reply.status(201).send({ item: await submitPermit(ctxFromRequest(req), getActor(req), req.params.id, req.body) }));

  r.get('/v1/properties/:id/permits', { schema: { summary: 'List the permits of a property', tags: ['STAY-03'], params: id }, preHandler: requireAuth }, async (req) => ({
    items: await listPermits(ctxFromRequest(req), getActor(req), req.params.id),
  }));

  r.get('/v1/admin/permits', {
    schema: { summary: 'List accommodation permits', tags: ['STAY-03'], querystring: z.object({ status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED']).default('PENDING') }) },
    preHandler: staff,
  }, async (req) => ({ items: await listPermitQueue(app.ctx.pool, req.query.status) }));

  for (const [action, to, summary] of [
    ['verify', 'VERIFIED', 'Verify an accommodation permit'],
    ['reject', 'REJECTED', 'Reject an accommodation permit'],
    ['revoke', 'REVOKED', 'Revoke a verified accommodation permit'],
  ] as const) {
    r.post(`/v1/admin/permits/:id/${action}`, { schema: { summary, tags: ['STAY-03'], params: id, body: reasonBody }, preHandler: staff }, async (req) => {
      if (to !== 'VERIFIED' && !req.body?.reason) throw badRequest('REASON_REQUIRED', 'A reason is required');
      return decidePermit(ctxFromRequest(req), req.params.id, to, req.body?.reason ?? null);
    });
  }

  r.get('/v1/admin/compliance/rules', {
    schema: { summary: 'List effective-dated compliance rules', tags: ['STAY-03'], querystring: z.object({ status: z.enum(['DRAFT', 'APPROVED', 'RETIRED']).optional(), jurisdiction: z.string().optional() }) },
    preHandler: staff,
  }, async (req) => ({ items: await listRules(app.ctx.pool, req.query) }));

  r.post('/v1/admin/compliance/rules', {
    schema: { summary: 'Propose a compliance rule version',
      tags: ['STAY-03'],
      body: z.object({
        ruleKey: z.string().trim().min(2).max(120),
        subjectType: z.enum(['PROPERTY', 'GUIDE', 'SUPPLIER', 'CHARTER']).default('PROPERTY'),
        jurisdiction,
        appliesTo: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))).default({}),
        requiredPermitTypes: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
        guestEligibility: z.record(z.string(), z.unknown()).default({}),
        effectiveFrom: isoDate,
        effectiveUntil: isoDate.nullish(),
        note: z.string().max(2000).nullish(),
      }),
    },
    preHandler: staff,
  }, async (req, reply) => reply.status(201).send({ item: await createRule(ctxFromRequest(req), req.body as any) }));

  r.post('/v1/admin/compliance/rules/:id/approve', { schema: { summary: 'Approve a compliance rule version', tags: ['STAY-03'], params: id, body: reasonBody }, preHandler: staff }, async (req) => ({
    item: await approveRule(ctxFromRequest(req), req.params.id, req.body?.reason ?? null),
  }));
  r.post('/v1/admin/compliance/rules/:id/retire', { schema: { summary: 'Retire a compliance rule version', tags: ['STAY-03'], params: id, body: reasonBody }, preHandler: staff }, async (req) => ({
    item: await retireRule(ctxFromRequest(req), req.params.id, req.body?.reason ?? null),
  }));

  r.post('/v1/compliance/evaluate', {
    schema: { tags: ['STAY-03'], summary: 'Evaluate a property against approved rules (owner or staff)', body: z.object({ propertyId: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req) => ({ item: await evaluateForActor(ctxFromRequest(req), getActor(req), req.body.propertyId) }));

  registerJob('compliance.permit-expiry', 24 * 3600 * 1000, (appCtx) => runPermitExpiry(systemCtx(appCtx, `job-permit-expiry-${Date.now()}`)));
}
