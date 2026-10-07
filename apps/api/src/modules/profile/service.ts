import type pg from 'pg';
import type { Db } from '../../platform/db.js';
import { maybeOne, withTx } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { badRequest, notFound, unprocessable } from '../../platform/errors.js';
import { currentConsentDocuments, recordConsents } from '../privacy/service.js';

export interface ProfilePatch {
  displayName?: string;
  phone?: string | null;
  locale?: string;
  legalName?: string | null;
  preferredName?: string | null;
  bio?: string | null;
  avatarMediaId?: string | null;
  birthYear?: number | null;
  country?: string | null;
  timezone?: string;
  languages?: string[];
  accessibility?: Record<string, unknown>;
}

export interface PreferencesPatch {
  currency?: string;
  travelStyles?: string[];
  interests?: string[];
  personalizationOptOut?: boolean;
  marketingOptIn?: boolean;
  extra?: Record<string, unknown>;
}

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function presentProfile(u: any, p: any) {
  return {
    userId: u.id,
    displayName: u.display_name,
    email: u.email,
    phone: u.phone,
    phoneVerified: !!u.phone_verified_at,
    locale: u.locale,
    legalName: p?.legal_name ?? null,
    preferredName: p?.preferred_name ?? null,
    bio: p?.bio ?? null,
    avatarMediaId: p?.avatar_media_id ?? null,
    birthYear: p?.birth_year ?? null,
    country: p?.country ?? null,
    timezone: p?.timezone ?? 'Asia/Seoul',
    languages: p?.languages ?? [],
    accessibility: p?.accessibility ?? {},
    updatedAt: p?.updated_at ?? u.updated_at,
  };
}

function presentPreferences(p: any) {
  return {
    currency: p.currency,
    travelStyles: p.travel_styles,
    interests: p.interests,
    personalizationOptOut: p.personalization_opt_out,
    marketingOptIn: p.marketing_opt_in,
    extra: p.extra,
    updatedAt: p.updated_at,
  };
}

export async function getProfile(db: Db, userId: string) {
  const u = await maybeOne(db, `SELECT * FROM users WHERE id = $1`, [userId]);
  if (!u) throw notFound('User');
  const p = await maybeOne(db, `SELECT * FROM user_profiles WHERE user_id = $1`, [userId]);
  return presentProfile(u, p);
}

/** Public, non-PII view used by host/guide/review surfaces. */
export async function getPublicProfile(db: Db, userId: string) {
  const row = await maybeOne(
    db,
    `SELECT u.id, u.display_name, u.status, u.identity_verified_at, u.created_at, p.preferred_name, p.bio, p.avatar_media_id, p.languages, p.country
       FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  if (!row || row.status === 'DELETED') return null;
  return {
    userId: row.id,
    displayName: row.preferred_name ?? row.display_name,
    bio: row.bio,
    avatarMediaId: row.avatar_media_id,
    languages: row.languages ?? [],
    country: row.country,
    identityVerified: !!row.identity_verified_at,
    memberSince: row.created_at,
  };
}

const USER_FIELDS: Record<string, string> = { displayName: 'display_name', phone: 'phone', locale: 'locale' };
const PROFILE_FIELDS: Record<string, string> = {
  legalName: 'legal_name',
  preferredName: 'preferred_name',
  bio: 'bio',
  avatarMediaId: 'avatar_media_id',
  birthYear: 'birth_year',
  country: 'country',
  timezone: 'timezone',
  languages: 'languages',
  accessibility: 'accessibility',
};
/** Fields whose values are PII: audit records only that they changed, never the values. */
const PII_FIELDS = new Set(['phone', 'legalName', 'birthYear']);

export async function updateProfile(pool: pg.Pool, ctx: Ctx, patch: ProfilePatch) {
  const userId = ctx.actor!.userId;
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) throw badRequest('INVALID_TIMEZONE', 'Unknown IANA timezone');
  const currentYear = new Date().getUTCFullYear();
  if (patch.birthYear != null && (patch.birthYear < currentYear - 120 || patch.birthYear > currentYear - 14)) {
    throw unprocessable('INVALID_BIRTH_YEAR', 'Birth year is out of the accepted range');
  }
  return withTx(pool, async (tx) => {
    const before = await getProfile(tx, userId);
    if (patch.avatarMediaId) {
      const m = await maybeOne(tx, `SELECT owner_id, status FROM media_assets WHERE id = $1`, [patch.avatarMediaId]);
      if (!m || m.owner_id !== userId) throw unprocessable('MEDIA_NOT_OWNED', 'Avatar media must be uploaded by you');
      if (m.status === 'REJECTED' || m.status === 'DELETED') throw unprocessable('MEDIA_NOT_USABLE', 'Avatar media is not usable');
    }
    const changed = Object.keys(patch).filter((k) => (patch as any)[k] !== undefined && JSON.stringify((patch as any)[k]) !== JSON.stringify((before as any)[k]));
    if (!changed.length) return before;

    const uSets: string[] = [];
    const uVals: unknown[] = [userId];
    for (const k of changed.filter((k) => k in USER_FIELDS)) {
      uVals.push((patch as any)[k]);
      uSets.push(`${USER_FIELDS[k]} = $${uVals.length}`);
    }
    if (changed.includes('phone')) uSets.push('phone_verified_at = NULL'); // a new number must be re-verified
    if (uSets.length) await tx.query(`UPDATE users SET ${uSets.join(', ')} WHERE id = $1`, uVals);

    const pCols = changed.filter((k) => k in PROFILE_FIELDS);
    if (pCols.length) {
      const cols = pCols.map((k) => PROFILE_FIELDS[k]);
      const vals = pCols.map((k) => (k === 'accessibility' ? JSON.stringify((patch as any)[k]) : (patch as any)[k]));
      await tx.query(
        `INSERT INTO user_profiles(user_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (user_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
        [userId, ...vals],
      );
    }
    const after = await getProfile(tx, userId);
    const redact = (o: any) => Object.fromEntries(changed.map((k) => [k, PII_FIELDS.has(k) ? '[changed]' : o[k]]));
    await audit(tx, ctx, { action: 'profile.updated', resourceType: 'user_profile', resourceId: userId, before: redact(before), after: redact(after), category: 'PRIVACY' });
    await emit(tx, ctx, { aggregateType: 'user', aggregateId: userId, eventType: 'profile.updated', payload: { userId, fields: changed } });
    return after;
  });
}

export async function getPreferences(db: Db, userId: string) {
  const p = await maybeOne(db, `SELECT * FROM user_preferences WHERE user_id = $1`, [userId]);
  return presentPreferences(p ?? { currency: 'KRW', travel_styles: [], interests: [], personalization_opt_out: false, marketing_opt_in: false, extra: {}, updated_at: null });
}

export async function updatePreferences(pool: pg.Pool, ctx: Ctx, patch: PreferencesPatch) {
  const userId = ctx.actor!.userId;
  return withTx(pool, async (tx) => {
    const before = await getPreferences(tx, userId);
    await tx.query(`INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const map: Record<string, string> = { currency: 'currency', travelStyles: 'travel_styles', interests: 'interests', personalizationOptOut: 'personalization_opt_out', extra: 'extra' };
    const changed = Object.keys(patch).filter((k) => (patch as any)[k] !== undefined && JSON.stringify((patch as any)[k]) !== JSON.stringify((before as any)[k]));
    const sets: string[] = [];
    const vals: unknown[] = [userId];
    for (const k of changed.filter((k) => k in map)) {
      vals.push(k === 'extra' ? JSON.stringify((patch as any)[k]) : (patch as any)[k]);
      sets.push(`${map[k]} = $${vals.length}`);
    }
    if (sets.length) await tx.query(`UPDATE user_preferences SET ${sets.join(', ')} WHERE user_id = $1`, vals);
    if (changed.includes('marketingOptIn')) {
      // Marketing opt-in is a consent: record versioned evidence (CORE-04), which also syncs the preference.
      const [doc] = await currentConsentDocuments(tx, ctx, 'MARKETING');
      if (!doc) throw unprocessable('CONSENT_DOCUMENT_UNAVAILABLE', 'No MARKETING consent document is available');
      await recordConsents(tx, ctx, userId, [{ type: 'MARKETING', version: doc.version, granted: !!patch.marketingOptIn }], 'PREFERENCES');
    }
    if (!changed.length) return before;
    const after = await getPreferences(tx, userId);
    const pick = (o: any) => Object.fromEntries(changed.map((k) => [k, o[k]]));
    await audit(tx, ctx, { action: 'preferences.updated', resourceType: 'user_preferences', resourceId: userId, before: pick(before), after: pick(after), category: 'GENERAL' });
    await emit(tx, ctx, { aggregateType: 'user', aggregateId: userId, eventType: 'profile.updated', payload: { userId, fields: changed.map((c) => `preferences.${c}`) } });
    return after;
  });
}

