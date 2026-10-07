import { z } from 'zod';
import { isoDate, pagination } from '../../platform/http.js';

export const dateRange = z.object({ start: isoDate, end: isoDate });
const terms = z.record(z.string(), z.unknown());
const guests = z.number().int().min(1).max(50);

export const profileBody = z.object({
  homeDescription: z.string().trim().max(5000).nullable().optional(),
  preferredDestinations: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  flexibleDates: z.boolean().optional(),
});

export const homesQuery = z.object({
  city: z.string().trim().min(1).max(100).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
  guests: z.coerce.number().int().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createBody = z.object({
  myPropertyId: z.uuid(),
  theirPropertyId: z.uuid(),
  datesA: dateRange,
  datesB: dateRange,
  guestsA: guests.default(1),
  guestsB: guests.default(1),
  message: z.string().max(4000).nullable().optional(),
  terms: terms.optional(),
});

export const counterBody = z.object({
  expectedVersion: z.number().int().min(1),
  datesA: dateRange.optional(),
  datesB: dateRange.optional(),
  guestsA: guests.optional(),
  guestsB: guests.optional(),
  message: z.string().max(4000).nullable().optional(),
  terms: terms.optional(),
});

export const acceptBody = z.object({ offerVersion: z.number().int().min(1) });
export const reasonBody = z.object({ reason: z.string().trim().max(1000).nullable().optional() }).default({});
export const cancelBody = z.object({ reason: z.string().trim().min(3).max(1000) });
export const signBody = z.object({ termsHash: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex') });
export const safetyAckBody = z.object({ acknowledged: z.literal(true) });
export const disputeBody = z.object({
  reason: z.string().trim().min(3).max(500),
  description: z.string().max(5000).nullable().optional(),
  severity: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
});

export const listQuery = pagination.extend({
  status: z
    .enum(['REQUESTED', 'COUNTERED', 'MUTUAL_ACCEPTED', 'VERIFICATION_PENDING', 'AGREEMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'DISPUTED', 'CANCELLED'])
    .optional(),
});
