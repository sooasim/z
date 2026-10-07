import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { acquireBlock, releaseBlock } from '../../platform/inventory.js';
import { decrypt, encrypt, hmacSha256, randomToken, safeEqual, sha256 } from '../../platform/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../platform/errors.js';
import { assertIcalUrl, buildIcs, defaultIcalFetcher, parseIcs, type IcalFetcher, type IcsEvent } from './ical.js';

/**
 * INT-01. External calendars are reconciled INTO JETPOOL's inventory authority: external busy ranges become
 * EXTERNAL inventory_blocks via platform acquireBlock; overlaps with JETPOOL reservations/exchanges/holds are
 * recorded as CONFLICT and JETPOOL wins (the external block is not created).
 */

export const PROVIDERS = ['ICAL', 'SMOOBU', 'GENERIC_WEBHOOK'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Account {
  id: string;
  owner_id: string;
  provider: Provider;
  config: { propertyId: string; icalHost?: string; [k: string]: unknown };
  secret_ref: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'ERROR';
  last_synced_at: string | null;
  created_at: string;
}

export const toAccountDto = (a: Account) => ({
  id: a.id,
  provider: a.provider,
  propertyId: a.config.propertyId,
  icalHost: a.config.icalHost ?? null,
  status: a.status,
  lastSyncedAt: a.last_synced_at,
  createdAt: a.created_at,
  hasSecret: !!a.secret_ref,
});

const seal = (app: AppContext, plain: string) => `enc:${encrypt(plain, app.config.DATA_ENCRYPTION_KEY)}`;
const unseal = (app: AppContext, ref: string | null) => (ref?.startsWith('enc:') ? decrypt(ref.slice(4), app.config.DATA_ENCRYPTION_KEY) : null);

export function getFetcher(app: AppContext): IcalFetcher {
  return (app.adapters.get('integrations.icalFetcher') as IcalFetcher | undefined) ?? defaultIcalFetcher({ allowHttp: app.config.NODE_ENV !== 'production' });
}

async function assertPropertyOwner(db: Db, propertyId: string, userId: string) {
  const p = await maybeOne<{ host_id: string }>(db, `SELECT host_id FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  if (p.host_id !== userId) throw forbidden('NOT_PROPERTY_OWNER', 'Only the host of this property can manage its integrations');
}

export async function getOwnedAccount(db: Db, id: string, userId: string): Promise<Account> {
  const a = await maybeOne<Account>(db, `SELECT * FROM integration_accounts WHERE id = $1`, [id]);
  if (!a || a.owner_id !== userId) throw notFound('Integration account');
  return a;
}

export async function listAccounts(db: Db, userId: string) {
  return (await q<Account>(db, `SELECT * FROM integration_accounts WHERE owner_id = $1 ORDER BY created_at DESC`, [userId])).map(toAccountDto);
}

export async function createAccount(db: Db, ctx: Ctx, userId: string, input: { provider: Provider; propertyId: string; icalUrl?: string }) {
  await assertPropertyOwner(db, input.propertyId, userId);
  let secretRef: string | null = null;
  let webhookSecret: string | null = null;
  const config: Account['config'] = { propertyId: input.propertyId };
  if (input.provider === 'ICAL') {
    if (!input.icalUrl) throw badRequest('ICAL_URL_REQUIRED', 'icalUrl is required for ICAL accounts');
    let u: URL;
    try {
      u = assertIcalUrl(input.icalUrl, ctx.app.config.NODE_ENV !== 'production');
    } catch (e: any) {
      throw badRequest('INVALID_ICAL_URL', e.message);
    }
    config.icalHost = u.hostname;
    secretRef = seal(ctx.app, input.icalUrl); // feed URLs embed secret tokens: encrypted at rest, never returned
  } else if (input.provider === 'GENERIC_WEBHOOK') {
    webhookSecret = randomToken(32);
    secretRef = seal(ctx.app, webhookSecret);
  }
  const dup = await maybeOne(db, `SELECT 1 FROM integration_accounts WHERE owner_id = $1 AND provider = $2 AND config->>'propertyId' = $3 AND status <> 'PAUSED'`, [userId, input.provider, input.propertyId]);
  if (dup) throw conflict('INTEGRATION_EXISTS', 'An active integration of this type already exists for the property');
  const a = await one<Account>(
    db,
    `INSERT INTO integration_accounts(owner_id, provider, config, secret_ref) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, input.provider, JSON.stringify(config), secretRef],
  );
  await audit(db, ctx, { action: 'integration.account.created', resourceType: 'integration_account', resourceId: a.id, after: { provider: a.provider, propertyId: input.propertyId }, category: 'GENERAL' });
  return { account: toAccountDto(a), webhookSecret };
}

export async function updateAccount(db: Db, ctx: Ctx, userId: string, id: string, patch: { status?: 'ACTIVE' | 'PAUSED'; icalUrl?: string }) {
  const a = await getOwnedAccount(db, id, userId);
  const config = { ...a.config };
  let secretRef = a.secret_ref;
  if (patch.icalUrl) {
    if (a.provider !== 'ICAL') throw badRequest('NOT_ICAL', 'icalUrl applies to ICAL accounts only');
    try {
      config.icalHost = assertIcalUrl(patch.icalUrl, ctx.app.config.NODE_ENV !== 'production').hostname;
    } catch (e: any) {
      throw badRequest('INVALID_ICAL_URL', e.message);
    }
    secretRef = seal(ctx.app, patch.icalUrl);
  }
  const row = await one<Account>(
    db,
    `UPDATE integration_accounts SET status = coalesce($2, status), config = $3, secret_ref = $4 WHERE id = $1 RETURNING *`,
    [id, patch.status ?? null, JSON.stringify(config), secretRef],
  );
  await audit(db, ctx, { action: 'integration.account.updated', resourceType: 'integration_account', resourceId: id, before: { status: a.status }, after: { status: row.status, urlChanged: !!patch.icalUrl }, category: 'GENERAL' });
  return toAccountDto(row);
}

async function logEvent(db: Db, accountId: string, e: { direction?: 'INBOUND' | 'OUTBOUND'; eventType: string; payload: unknown; outcome: 'APPLIED' | 'CONFLICT' | 'IGNORED' | 'ERROR'; detail?: string }) {
  await db.query(`INSERT INTO integration_events(account_id, direction, event_type, payload, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6)`, [
    accountId,
    e.direction ?? 'INBOUND',
    e.eventType,
    JSON.stringify(e.payload ?? {}),
    e.outcome,
    e.detail ?? null,
  ]);
}

export interface ApplyCounts { applied: number; unchanged: number; conflicts: number; removed: number; ignored: number }
const emptyCounts = (): ApplyCounts => ({ applied: 0, unchanged: 0, conflicts: 0, removed: 0, ignored: 0 });

/** Upsert one external busy range for the account's property. JETPOOL inventory always wins on overlap. */
export async function applyExternalRange(tx: Tx, ctx: Ctx, account: Account, ev: IcsEvent, counts: ApplyCounts, eventType = 'VEVENT') {
  const propertyId = account.config.propertyId;
  const payload = { uid: ev.uid, start: ev.start, end: ev.end };
  if (ev.uid.endsWith('@jetpool')) {
    // our own export echoed back by the external channel
    counts.ignored++;
    return;
  }
  const mapping = await maybeOne<{ id: string; internal_id: string }>(
    tx,
    `SELECT id, internal_id FROM integration_mappings WHERE account_id = $1 AND external_type = 'VEVENT' AND external_id = $2`,
    [account.id, ev.uid],
  );
  if (mapping) {
    const block = await maybeOne<{ state: string; same: boolean }>(
      tx,
      `SELECT state, stay_range = daterange($2::date, $3::date, '[)') AS same FROM inventory_blocks WHERE id = $1`,
      [mapping.internal_id, ev.start, ev.end],
    );
    if (block?.state === 'ACTIVE' && block.same) {
      counts.unchanged++;
      return;
    }
    if (block?.state === 'ACTIVE') await releaseBlock(tx, mapping.internal_id);
  }
  try {
    const b = await acquireBlock(tx, {
      propertyId,
      start: ev.start,
      end: ev.end,
      blockType: 'EXTERNAL',
      sourceType: 'INTEGRATION',
      sourceId: account.id,
      createdBy: account.owner_id,
      note: `${account.provider} ${ev.uid}`.slice(0, 200),
    });
    await tx.query(
      `INSERT INTO integration_mappings(account_id, external_type, external_id, internal_type, internal_id) VALUES ($1,'VEVENT',$2,'INVENTORY_BLOCK',$3)
       ON CONFLICT (account_id, external_type, external_id) DO UPDATE SET internal_id = EXCLUDED.internal_id`,
      [account.id, ev.uid, b.id],
    );
    await logEvent(tx, account.id, { eventType, payload, outcome: 'APPLIED' });
    counts.applied++;
  } catch (err: any) {
    if (err?.code !== 'INVENTORY_UNAVAILABLE') throw err;
    const clash = await maybeOne<{ block_type: string; source_type: string }>(
      tx,
      `SELECT block_type, source_type FROM inventory_blocks WHERE property_id = $1 AND state = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now())
         AND stay_range && daterange($2::date, $3::date, '[)') LIMIT 1`,
      [propertyId, ev.start, ev.end],
    );
    await logEvent(tx, account.id, {
      eventType,
      payload: { ...payload, conflictsWith: clash?.block_type ?? 'UNKNOWN' },
      outcome: 'CONFLICT',
      detail: 'Overlaps JETPOOL inventory; JETPOOL authority wins, external block not applied',
    });
    await notify(tx, ctx, {
      userId: account.owner_id,
      templateKey: 'integration.conflict',
      category: 'TRANSACTIONAL',
      title: '외부 캘린더 충돌 / Calendar conflict',
      body: `${ev.start} ~ ${ev.end} 외부 일정이 JETPOOL 예약과 겹칩니다.`,
      data: { accountId: account.id, propertyId, start: ev.start, end: ev.end },
      dedupeKey: `int-conflict:${account.id}:${ev.uid}:${ev.start}:${ev.end}`,
    });
    counts.conflicts++;
  }
}

export async function removeExternalRange(tx: Tx, account: Account, externalId: string, counts: ApplyCounts, eventType = 'VEVENT_REMOVED') {
  const m = await maybeOne<{ id: string; internal_id: string }>(
    tx,
    `DELETE FROM integration_mappings WHERE account_id = $1 AND external_type = 'VEVENT' AND external_id = $2 RETURNING id, internal_id`,
    [account.id, externalId],
  );
  if (!m) return;
  // only ever release EXTERNAL blocks created by this integration
  await tx.query(`UPDATE inventory_blocks SET state = 'RELEASED', released_at = now() WHERE id = $1 AND state = 'ACTIVE' AND block_type = 'EXTERNAL' AND source_id = $2`, [m.internal_id, account.id]);
  await logEvent(tx, account.id, { eventType, payload: { uid: externalId }, outcome: 'APPLIED' });
  counts.removed++;
}

/** Fetch + reconcile one iCal account. Network I/O happens outside the DB transaction. */
export async function syncIcalAccount(app: AppContext, accountId: string, ctx: Ctx = systemCtx(app, `ical-sync-${accountId}`)) {
  const account = await maybeOne<Account>(app.pool, `SELECT * FROM integration_accounts WHERE id = $1`, [accountId]);
  if (!account) throw notFound('Integration account');
  if (account.provider !== 'ICAL') throw badRequest('NOT_ICAL', 'Only ICAL accounts can be synced by URL');
  if (account.status === 'PAUSED') throw conflict('INTEGRATION_PAUSED', 'The integration is paused');
  const url = unseal(app, account.secret_ref);
  if (!url) throw conflict('INTEGRATION_MISCONFIGURED', 'No feed URL configured');
  let events: IcsEvent[];
  try {
    events = parseIcs(await getFetcher(app)(url));
  } catch (err: any) {
    await withTx(app.pool, async (tx) => {
      await logEvent(tx, account.id, { eventType: 'ICAL_FETCH', payload: { host: account.config.icalHost ?? null }, outcome: 'ERROR', detail: String(err?.message ?? err).slice(0, 300) });
      await tx.query(`UPDATE integration_accounts SET status = 'ERROR' WHERE id = $1 AND status = 'ACTIVE'`, [account.id]);
    });
    return { accountId, status: 'ERROR' as const, error: String(err?.message ?? err), counts: emptyCounts() };
  }
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 2 * 365 * 86400_000).toISOString().slice(0, 10);
  const relevant = events.filter((e) => e.status !== 'CANCELLED' && e.end > today && e.start < horizon).map((e) => ({ ...e, start: e.start < today ? today : e.start }));
  const counts = await withTx(app.pool, async (tx) => {
    const locked = await one<{ ok: boolean }>(tx, `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`ical-sync:${account.id}`]);
    if (!locked.ok) throw conflict('SYNC_IN_PROGRESS', 'A sync is already running for this account');
    const c = emptyCounts();
    for (const ev of relevant) await applyExternalRange(tx, ctx, account, ev, c);
    const present = new Set(relevant.map((e) => e.uid));
    const mapped = await q<{ external_id: string }>(tx, `SELECT external_id FROM integration_mappings WHERE account_id = $1 AND external_type = 'VEVENT'`, [account.id]);
    for (const m of mapped) if (!present.has(m.external_id)) await removeExternalRange(tx, account, m.external_id, c);
    await tx.query(`UPDATE integration_accounts SET last_synced_at = now(), status = 'ACTIVE' WHERE id = $1`, [account.id]);
    await emit(tx, ctx, {
      aggregateType: 'integration_account',
      aggregateId: account.id,
      eventType: 'integration.sync.completed',
      payload: { accountId: account.id, propertyId: account.config.propertyId, provider: account.provider, ...c, feedEvents: events.length },
    });
    return c;
  });
  return { accountId, status: 'ACTIVE' as const, counts };
}

/** Periodic sync for ACTIVE/ERROR iCal accounts not synced in the last `minutes`. */
export async function syncDueAccounts(app: AppContext, minutes = 30) {
  const due = await q<{ id: string }>(
    app.pool,
    `SELECT id FROM integration_accounts WHERE provider = 'ICAL' AND status IN ('ACTIVE','ERROR')
        AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => $1)) ORDER BY last_synced_at NULLS FIRST LIMIT 50`,
    [minutes],
  );
  const results = [];
  for (const d of due) {
    try {
      results.push(await syncIcalAccount(app, d.id));
    } catch (err: any) {
      app.log.warn({ err: err?.message, accountId: d.id }, 'ical sync failed');
    }
  }
  return results;
}

// ---------------------------------------------------------------- export

export async function issueExportToken(db: Db, ctx: Ctx, userId: string, propertyId: string) {
  await assertPropertyOwner(db, propertyId, userId);
  const token = randomToken(32);
  await db.query(
    `INSERT INTO ical_export_tokens(property_id, token_hash, created_by) VALUES ($1,$2,$3)
     ON CONFLICT (property_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_by = EXCLUDED.created_by, created_at = now()`,
    [propertyId, sha256(token), userId],
  );
  await audit(db, ctx, { action: 'integration.ical_export_token.issued', resourceType: 'property', resourceId: propertyId, category: 'SECURITY' });
  return { token, url: `${ctx.app.config.PUBLIC_API_URL}/v1/integrations/ical/${propertyId}.ics?token=${token}` };
}

export async function exportIcs(db: Db, propertyId: string, token: string) {
  const row = await maybeOne<{ token_hash: string }>(db, `SELECT token_hash FROM ical_export_tokens WHERE property_id = $1`, [propertyId]);
  if (!row || !safeEqual(row.token_hash, sha256(token))) throw unauthorized('Invalid calendar token');
  const blocks = await q<{ id: string; start: string; end: string }>(
    db,
    `SELECT id, lower(stay_range)::text AS start, upper(stay_range)::text AS end FROM inventory_blocks
      WHERE property_id = $1 AND state = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now())
        AND block_type <> 'EXTERNAL' AND upper(stay_range) > current_date - 30
      ORDER BY lower(stay_range)`,
    [propertyId],
  );
  const closed = await q<{ start: string; end: string }>(
    db,
    `SELECT min(day)::text AS start, (max(day) + 1)::text AS end FROM (
        SELECT day, day - (row_number() OVER (ORDER BY day))::int AS grp FROM availability_days
         WHERE property_id = $1 AND status = 'UNAVAILABLE' AND day >= current_date - 30) d
      GROUP BY grp ORDER BY 1`,
    [propertyId],
  );
  return buildIcs('JETPOOL', [...blocks.map((b) => ({ uid: b.id, start: b.start, end: b.end })), ...closed.map((c) => ({ uid: `closed-${propertyId}-${c.start}`, start: c.start, end: c.end }))]);
}

// ---------------------------------------------------------------- generic webhook (HMAC)

export const WEBHOOK_TOLERANCE_SEC = 300;

/** `x-jetpool-signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<rawBody>")>` */
export function signWebhook(secret: string, rawBody: string, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${hmacSha256(secret, `${ts}.${rawBody}`)}`;
}

export function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC || !parts.v1) return false;
  return safeEqual(hmacSha256(secret, `${ts}.${rawBody}`), parts.v1);
}

export interface WebhookPayload { eventId: string; type: 'BLOCK_UPSERT' | 'BLOCK_DELETE'; externalId: string; start?: string; end?: string }

export async function handleInboundWebhook(app: AppContext, ctx: Ctx, accountId: string, rawBody: string, signature: string | undefined, payload: WebhookPayload) {
  const account = await maybeOne<Account>(app.pool, `SELECT * FROM integration_accounts WHERE id = $1 AND provider = 'GENERIC_WEBHOOK'`, [accountId]);
  const secret = account ? unseal(app, account.secret_ref) : null;
  if (!account || !secret || !verifyWebhookSignature(secret, rawBody, signature)) throw unauthorized('Invalid webhook signature');
  if (account.status === 'PAUSED') throw conflict('INTEGRATION_PAUSED', 'The integration is paused');
  return withTx(app.pool, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO webhook_events(provider, external_event_id, event_type, payload_hash, payload, signature_valid, processed_at)
       VALUES ('INTEGRATION', $1, $2, $3, $4, true, now()) ON CONFLICT (provider, external_event_id) DO NOTHING`,
      [`${account.id}:${payload.eventId}`, payload.type, sha256(rawBody), rawBody],
    );
    if (ins.rowCount === 0) return { duplicate: true, counts: emptyCounts() };
    const c = emptyCounts();
    if (payload.type === 'BLOCK_UPSERT') {
      if (!payload.start || !payload.end) throw badRequest('INVALID_RANGE', 'start and end are required');
      await applyExternalRange(tx, ctx, account, { uid: payload.externalId, start: payload.start, end: payload.end, status: null }, c, 'WEBHOOK_BLOCK_UPSERT');
    } else {
      await removeExternalRange(tx, account, payload.externalId, c, 'WEBHOOK_BLOCK_DELETE');
    }
    await emit(tx, ctx, { aggregateType: 'integration_account', aggregateId: account.id, eventType: 'integration.sync.completed', payload: { accountId: account.id, provider: account.provider, source: 'webhook', ...c } });
    return { duplicate: false, counts: c };
  });
}

export async function listIntegrationEvents(db: Db, accountId: string, limit: number) {
  return q(db, `SELECT id, direction, event_type, payload, outcome, detail, created_at FROM integration_events WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`, [accountId, limit]);
}
