import type { FastifyInstance } from 'fastify';
import identity from './identity/index.js';
import profile from './profile/index.js';
import roles from './roles/index.js';
import privacy from './privacy/index.js';
import verification from './verification/index.js';
import reviews from './reviews/index.js';
import disputes from './disputes/index.js';
import hosts from './hosts/index.js';
import support from './support/index.js';
import properties from './properties/index.js';
import media from './media/index.js';
import compliance from './compliance/index.js';
import search from './search/index.js';
import favorites from './favorites/index.js';
import geo from './geo/index.js';
import booking from './booking/index.js';
import exchange from './exchange/index.js';
import guide from './guide/index.js';
import travel from './travel/index.js';
import charter from './charter/index.js';
import payments from './payments/index.js';
import finance from './finance/index.js';
import messaging from './messaging/index.js';
import notifications from './notifications/index.js';
import admin from './admin/index.js';
import cms from './cms/index.js';
import analytics from './analytics/index.js';
import ai from './ai/index.js';
import integrations from './integrations/index.js';
import risk from './risk/index.js';

/**
 * Module registry. Order matters only for adapter registration (payments before domains that
 * consume it is NOT required: cross-module calls go through exported service functions and the
 * payment-subject / outbox contracts in src/platform).
 */
export const MODULES = { identity, profile, roles, privacy, verification, reviews, disputes, hosts, support, properties, media, compliance, search, favorites, geo, booking, exchange, guide, travel, charter, payments, finance, messaging, notifications, admin, cms, analytics, ai, integrations, risk };

export async function registerModules(app: FastifyInstance) {
  for (const [name, plugin] of Object.entries(MODULES)) {
    try {
      await app.register(plugin);
    } catch (err: any) {
      throw new Error(`module ${name} failed to register: ${err?.message ?? err}`);
    }
  }
}
