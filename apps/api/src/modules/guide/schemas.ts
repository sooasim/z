import { z } from 'zod';
import { GUIDE_TYPES } from './fsm.js';

const tag = z.string().trim().min(1).max(60);
const isoDateTime = z.iso.datetime({ offset: true });

export const profileCreateBody = z.object({
  guideType: z.enum(GUIDE_TYPES),
  headline: z.string().trim().max(200).optional(),
  bio: z.string().max(5000).optional(),
  languages: z.array(tag).max(20).default([]),
  regions: z.array(tag).max(30).default([]),
  interests: z.array(tag).max(30).default([]),
  specialties: z.array(tag).max(30).default([]),
  city: z.string().trim().max(120).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  hourlyPriceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  currency: z.enum(['KRW', 'USD', 'JPY', 'EUR']).default('KRW'),
  maxGroupSize: z.number().int().min(1).max(50).default(4),
});
export type ProfileCreateInput = z.infer<typeof profileCreateBody>;

export const profilePatchBody = z.object({
  guideType: z.enum(GUIDE_TYPES).optional(),
  headline: z.string().trim().max(200).nullable().optional(),
  bio: z.string().max(5000).nullable().optional(),
  languages: z.array(tag).max(20).optional(),
  regions: z.array(tag).max(30).optional(),
  interests: z.array(tag).max(30).optional(),
  specialties: z.array(tag).max(30).optional(),
  city: z.string().trim().max(120).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  hourlyPriceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  currency: z.enum(['KRW', 'USD', 'JPY', 'EUR']).optional(),
  maxGroupSize: z.number().int().min(1).max(50).optional(),
});
export type ProfilePatchInput = z.infer<typeof profilePatchBody>;

export const qualificationBody = z.object({
  qualificationType: z.enum(['BUSINESS_REGISTRATION', 'GUIDE_LICENSE', 'INSURANCE', 'TRAVEL_AGENCY_REGISTRATION', 'OTHER']),
  documentMediaId: z.uuid(),
  referenceNo: z.string().trim().max(100).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type QualificationInput = z.infer<typeof qualificationBody>;

export const reviewDecisionBody = z.object({ reason: z.string().trim().min(1).max(1000).optional() });

export const availabilityBody = z.object({
  /** replace window; default = from now to the latest supplied slot end */
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  slots: z.array(z.object({ startAt: isoDateTime, endAt: isoDateTime, status: z.enum(['AVAILABLE', 'BLOCKED']).default('AVAILABLE') })).max(500).default([]),
  weekly: z
    .object({
      timezone: z.string().min(1).max(64).default('Asia/Seoul'),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      rules: z
        .array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }))
        .min(1)
        .max(50),
    })
    .optional(),
});
export type AvailabilityInput = z.infer<typeof availabilityBody>;

export const availabilityQuery = z.object({ from: isoDateTime, to: isoDateTime });

const csv = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []));

export const searchQuery = z.object({
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  languages: csv,
  interests: csv,
  types: csv.pipe(z.array(z.enum(GUIDE_TYPES))),
  pricing: z.enum(['free', 'paid', 'any']).default('any'),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  availableOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  minRating: z.coerce.number().min(0).max(5).optional(),
  maxPriceMinor: z.coerce.number().int().nonnegative().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchInput = z.infer<typeof searchQuery>;

export const requestCreateBody = z.object({
  guideId: z.uuid().optional(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  partySize: z.number().int().min(1).max(50).default(1),
  city: z.string().trim().max(120).optional(),
  languages: z.array(tag).max(10).default([]),
  interests: z.array(tag).max(20).default([]),
  scope: z.record(z.string(), z.unknown()).default({}),
  message: z.string().max(4000).optional(),
});
export type RequestCreateInput = z.infer<typeof requestCreateBody>;

export const offerBody = z.object({
  startAt: isoDateTime,
  endAt: isoDateTime,
  paid: z.boolean(),
  priceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  itinerary: z.string().max(8000).optional(),
});
export type OfferInput = z.infer<typeof offerBody>;

export const counterBody = z.object({
  startAt: isoDateTime,
  endAt: isoDateTime,
  priceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  itinerary: z.string().max(8000).optional(),
});
export type CounterInput = z.infer<typeof counterBody>;

export const acceptBody = z.object({ offerVersion: z.number().int().min(1) });
export const reasonBody = z.object({ reason: z.string().trim().max(1000).optional() }).default({});
export const disputeBody = z.object({ reason: z.string().trim().min(1).max(2000) });

export const requestListQuery = z.object({
  role: z.enum(['traveler', 'guide', 'open']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export const bookingListQuery = z.object({
  role: z.enum(['traveler', 'guide']).optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
