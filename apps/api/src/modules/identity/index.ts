import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAal2, requireAuth } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { notFound } from '../../platform/errors.js';
import { CONSENT_TYPES } from '../privacy/service.js';
import { OAUTH_PROVIDERS } from './oauth.js';
import { accountSummary } from './users.js';
import * as svc from './service.js';

const TAG = ['CORE-01'];
const email = z.email().max(254);
const password = z.string().min(1).max(256);
export const consentInput = z.object({ type: z.enum(CONSENT_TYPES), version: z.string().min(1).max(64), granted: z.boolean() });
const providerParams = z.object({ provider: z.enum(OAUTH_PROVIDERS) });
const sessionOut = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number(),
  refreshExpiresAt: z.string(),
  sessionId: z.string(),
  aal: z.enum(['aal1', 'aal2']),
});

/** CORE-01 Identity & Authentication. */
export default async function identityModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  const authLimit = { rateLimit: { max: Math.max(10, Math.floor(app.ctx.config.RATE_LIMIT_PER_MIN / 20)), timeWindow: '1 minute' } };

  r.post('/v1/auth/signup', {
    schema: {
      tags: TAG,
      summary: 'Sign up with email + password (requires TERMS and PRIVACY consent for current versions)',
      body: z.object({
        email,
        password,
        displayName: z.string().trim().min(1).max(80).optional(),
        locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
        consents: z.array(consentInput).min(1).max(20),
      }),
      response: { 201: sessionOut.extend({ user: z.any() }) },
    },
    config: authLimit,
  }, async (req, reply) => reply.status(201).send(await svc.signup(pool, ctxFromRequest(req), req.body)));

  r.post('/v1/auth/login', {
    schema: { tags: TAG, summary: 'Email + password login (per-account lockout with exponential backoff)', body: z.object({ email, password }) },
    config: authLimit,
  }, async (req) => svc.passwordLogin(pool, ctxFromRequest(req), req.body));

  r.post('/v1/auth/otp/request', {
    schema: { tags: TAG, summary: 'Request an email one-time login code (always 202; the code is delivered out-of-band only)', body: z.object({ email }) },
    config: authLimit,
  }, async (req, reply) => {
    await svc.requestEmailOtp(pool, ctxFromRequest(req), req.body.email);
    return reply.status(202).send({ accepted: true });
  });

  r.post('/v1/auth/otp/verify', {
    schema: { tags: TAG, summary: 'Log in with an email one-time code', body: z.object({ email, code: z.string().regex(/^\d{6}$/) }) },
    config: authLimit,
  }, async (req) => svc.verifyEmailOtp(pool, ctxFromRequest(req), req.body));

  r.post('/v1/auth/refresh', {
    schema: { tags: TAG, summary: 'Rotate refresh token (reuse of a rotated token revokes all sessions)', body: z.object({ refreshToken: z.string().min(16).max(256) }), response: { 200: sessionOut } },
    config: authLimit,
  }, async (req) => svc.refreshSession(pool, ctxFromRequest(req), req.body.refreshToken));

  r.post('/v1/auth/logout', { schema: { tags: TAG, summary: 'Revoke the current session' }, preHandler: requireAuth }, async (req, reply) => {
    await svc.logout(pool, ctxFromRequest(req), false);
    return reply.status(204).send();
  });

  r.post('/v1/auth/logout-all', { schema: { tags: TAG, summary: 'Revoke every session of the current user' }, preHandler: requireAuth }, async (req) => ({
    revoked: await svc.logout(pool, ctxFromRequest(req), true),
  }));

  r.get('/v1/auth/sessions', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({ items: await svc.listSessions(pool, getActor(req)) }));

  r.delete('/v1/auth/sessions/:id', { schema: { tags: TAG, params: z.object({ id: z.uuid() }) }, preHandler: requireAuth }, async (req, reply) => {
    await svc.revokeOwnSession(pool, ctxFromRequest(req), req.params.id);
    return reply.status(204).send();
  });

  // ---- password -------------------------------------------------------------------------------------------
  r.post('/v1/auth/password/reset/request', {
    schema: { tags: TAG, summary: 'Request a password reset (always 202)', body: z.object({ email }) },
    config: authLimit,
  }, async (req, reply) => {
    await svc.requestPasswordReset(pool, ctxFromRequest(req), req.body.email);
    return reply.status(202).send({ accepted: true });
  });

  r.post('/v1/auth/password/reset/confirm', {
    schema: { tags: TAG, summary: 'Set a new password with a reset token; revokes all sessions', body: z.object({ email, token: z.string().min(10).max(200), newPassword: password }) },
    config: authLimit,
  }, async (req, reply) => {
    await svc.confirmPasswordReset(pool, ctxFromRequest(req), req.body);
    return reply.status(204).send();
  });

  r.post('/v1/auth/password/change', {
    schema: { tags: TAG, body: z.object({ currentPassword: password.optional(), newPassword: password }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    await svc.changePassword(pool, ctxFromRequest(req), req.body);
    return reply.status(204).send();
  });

  // ---- email verification ---------------------------------------------------------------------------------
  r.post('/v1/auth/email/verify/request', { schema: { tags: TAG }, preHandler: requireAuth, config: authLimit }, async (req, reply) => {
    await svc.requestEmailVerification(pool, ctxFromRequest(req), getActor(req).userId);
    return reply.status(202).send({ accepted: true });
  });
  r.post('/v1/auth/email/verify/confirm', {
    schema: { tags: TAG, body: z.object({ code: z.string().regex(/^\d{6}$/) }) },
    preHandler: requireAuth,
  }, async (req) => {
    await svc.confirmEmailVerification(pool, ctxFromRequest(req), getActor(req).userId, req.body.code);
    return { emailVerified: true };
  });

  // ---- MFA (TOTP) -----------------------------------------------------------------------------------------
  r.get('/v1/auth/mfa', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => svc.mfaStatus(pool, getActor(req).userId));

  r.post('/v1/auth/mfa/totp/enroll', { schema: { tags: TAG, summary: 'Start TOTP enrollment (secret shown once)' }, preHandler: requireAuth }, async (req, reply) =>
    reply.status(201).send(await svc.enrollTotp(pool, ctxFromRequest(req))),
  );

  r.post('/v1/auth/mfa/totp/verify', {
    schema: { tags: TAG, summary: 'Confirm TOTP enrollment; returns one-time recovery codes and upgrades the session to AAL2', body: z.object({ factorId: z.uuid(), code: z.string().regex(/^\d{6}$/) }) },
    preHandler: requireAuth,
    config: authLimit,
  }, async (req) => svc.verifyTotpEnrollment(pool, ctxFromRequest(req), req.body));

  r.post('/v1/auth/mfa/challenge', {
    schema: {
      tags: TAG,
      summary: 'Step-up: verify TOTP or a recovery code and upgrade the current session to AAL2',
      body: z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(6).max(32).optional() }),
    },
    preHandler: requireAuth,
    config: authLimit,
  }, async (req) => svc.mfaChallenge(pool, ctxFromRequest(req), req.body));

  r.post('/v1/auth/mfa/recovery-codes', { schema: { tags: TAG, summary: 'Regenerate recovery codes (AAL2)' }, preHandler: [requireAuth, requireAal2] }, async (req) =>
    svc.regenerateRecoveryCodes(pool, ctxFromRequest(req)),
  );

  r.delete('/v1/auth/mfa/totp', {
    schema: { tags: TAG, summary: 'Disable TOTP (AAL2 + current code)', body: z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(6).max(32).optional() }) },
    preHandler: [requireAuth, requireAal2],
  }, async (req, reply) => {
    await svc.disableTotp(pool, ctxFromRequest(req), req.body ?? {});
    return reply.status(204).send();
  });

  // ---- OAuth ----------------------------------------------------------------------------------------------
  r.post('/v1/auth/oauth/:provider/start', {
    schema: {
      tags: TAG,
      summary: 'Start OAuth login/signup (authorization-code + PKCE). Consents may be supplied for first-time signup.',
      params: providerParams,
      body: z.object({ consents: z.array(consentInput).max(20).optional(), returnTo: z.string().max(500).regex(/^\/[^/]/).optional() }).nullish(),
    },
    config: authLimit,
  }, async (req) => svc.startOAuth(pool, ctxFromRequest(req), req.params.provider, { mode: 'login', ...(req.body ?? {}) }));

  r.post('/v1/auth/oauth/:provider/link/start', {
    schema: { tags: TAG, summary: 'Start linking a social provider to the signed-in account', params: providerParams },
    preHandler: requireAuth,
  }, async (req) => svc.startOAuth(pool, ctxFromRequest(req), req.params.provider, { mode: 'link' }));

  r.post('/v1/auth/oauth/:provider/callback', {
    schema: {
      tags: TAG,
      summary: 'Complete OAuth: logs in, signs up (new identity, no existing email account) or links (link flow)',
      params: providerParams,
      body: z.object({ code: z.string().min(1).max(2048), state: z.string().min(16).max(200), consents: z.array(consentInput).max(20).optional() }),
    },
    config: authLimit,
  }, async (req, reply) => {
    const res = await svc.oauthCallback(pool, ctxFromRequest(req), req.params.provider, req.body);
    return reply.status(res.status).send(res.body);
  });

  r.get('/v1/me/identities', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({ items: await svc.listIdentities(pool, getActor(req).userId) }));

  r.delete('/v1/me/identities/:provider', { schema: { tags: TAG, params: providerParams }, preHandler: requireAuth }, async (req, reply) => {
    await svc.unlinkProvider(pool, ctxFromRequest(req), req.params.provider);
    return reply.status(204).send();
  });

  // ---- me -------------------------------------------------------------------------------------------------
  r.get('/v1/me', { schema: { tags: TAG, summary: 'Current account, roles and session assurance level' }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const user = await accountSummary(pool, actor.userId);
    if (!user) throw notFound('User');
    return { user, session: { id: actor.sessionId, aal: actor.aal } };
  });
}
