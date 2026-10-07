import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { StateMachine } from '../../platform/fsm.js';
import { badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { cursorColumns, decodeCursor, page } from '../../platform/http.js';

/**
 * PLAT-05 Security / Risk.
 *
 * Contract (consumed by any module):
 *   recordRiskEvent(db, ctx, { subjectType, subjectId, riskType, severity, score?, detail? }) → risk event id
 *   riskScore(db, subjectType, subjectId, windowMinutes = 60) → 0..100 (sum of non-false-positive scores, capped)
 *
 * Every detection emits `risk.detected` in the caller's transaction; HIGH/CRITICAL also notify ADMIN users
 * (SECURITY category). `detail` is operational metadata only — never secrets, tokens, card data or message bodies.
 */

export const SUBJECT_TYPES = ['USER', 'IP', 'PROPERTY', 'PAYMENT', 'MEDIA', 'DEVICE'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const RISK_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
/** Known risk types (risk_type is open text matching ^[A-Z][A-Z0-9_]+$; these are the ones the platform emits). */
export const RISK_TYPES = [
  'LOGIN_FAILURE_BURST',
  'IMPOSSIBLE_TRAVEL',
  'SESSION_COMPROMISED',
  'CARD_TESTING',
  'UPLOAD_REJECTED',
  'CONTACT_LEAK',
  'ABUSE',
  'RATE_LIMIT',
  'MANUAL',
] as const;
export const RISK_TYPE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const INCIDENT_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED', 'POSTMORTEM_DONE'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const DEFAULT_SCORE: Record<Severity, number> = { LOW: 10, MEDIUM: 30, HIGH: 60, CRITICAL: 90 };
const SEVERITY_RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const RESPONDER_ROLES = ['ADMIN', 'COMPLIANCE', 'SUPPORT'];

export const riskEventFsm = new StateMachine<RiskStatus>('RISK_EVENT', {
  OPEN: ['ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE'],
  ACKNOWLEDGED: ['OPEN', 'RESOLVED', 'FALSE_POSITIVE'],
  RESOLVED: ['OPEN'],
  FALSE_POSITIVE: ['OPEN'],
});

export const incidentFsm = new StateMachine<IncidentStatus>('SECURITY_INCIDENT', {
  OPEN: ['INVESTIGATING', 'MITIGATED', 'RESOLVED'],
  INVESTIGATING: ['MITIGATED', 'RESOLVED'],
  MITIGATED: ['INVESTIGATING', 'RESOLVED'],
  RESOLVED: ['INVESTIGATING', 'POSTMORTEM_DONE'],
  POSTMORTEM_DONE: [],
});

// ------------------------------------------------------------------------------------------------ DTOs

export function toRiskEventDto(r: any) {
  return {
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    riskType: r.risk_type,
    severity: r.severity,
    score: r.score,
    detail: r.detail ?? {},
    status: r.status,
    sourceEventId: r.source_event_id ?? null,
    correlationId: r.correlation_id ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedBy: r.resolved_by ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolutionNote: r.resolution_note ?? null,
  };
}

export function toIncidentDto(i: any) {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    summary: i.summary ?? null,
    commanderId: i.commander_id ?? null,
    relatedRiskEventIds: i.related_risk_event_ids ?? [],
    openedBy: i.opened_by,
    openedAt: i.opened_at,
    mitigatedAt: i.mitigated_at ?? null,
    resolvedAt: i.resolved_at ?? null,
    postmortemUrl: i.postmortem_url ?? null,
    version: i.version,
    updatedAt: i.updated_at,
  };
}

export function toIncidentEventDto(e: any) {
  return {
    id: e.id,
    incidentId: e.incident_id,
    type: e.event_type,
    fromStatus: e.from_status ?? null,
    toStatus: e.to_status ?? null,
    note: e.note ?? null,
    data: e.data ?? {},
    actorId: e.actor_id ?? null,
    createdAt: e.created_at,
  };
}

// ------------------------------------------------------------------------------------------------ risk events

export interface RiskEventInput {
  subjectType: SubjectType;
  subjectId: string;
  riskType: string;
  severity: Severity;
  score?: number;
  detail?: Record<string, unknown>;
  /** Idempotency for replays/bursts: a second call with the same key returns the first event's id (no new event). */
  dedupeKey?: string;
  /** Outbox event the detection was derived from. */
  sourceEventId?: string;
}

const SECRET_KEY_RE = /(pass(word)?|secret|token|cvc|cvv|card_?number|pan|authorization|cookie|api_?key)/i;

/** Defensive: drop secret-looking keys and cap sizes so a detector can never persist credentials into risk detail. */
function sanitizeDetail(detail: unknown, depth = 0): Record<string, unknown> {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail as Record<string, unknown>).slice(0, 50)) {
    if (SECRET_KEY_RE.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 1000);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = depth < 2 ? sanitizeDetail(v, depth + 1) : '[object]';
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => (typeof x === 'string' ? x.slice(0, 200) : x && typeof x === 'object' ? '[object]' : x));
    else out[k] = v;
  }
  return out;
}

/** Record a risk detection. Emits `risk.detected`; HIGH/CRITICAL notify ADMIN users. Returns the risk event id. */
export async function recordRiskEvent(db: Db, ctx: Ctx, input: RiskEventInput): Promise<string> {
  if (!SUBJECT_TYPES.includes(input.subjectType)) throw badRequest('INVALID_SUBJECT_TYPE', `Unknown subject type ${input.subjectType}`);
  if (!SEVERITIES.includes(input.severity)) throw badRequest('INVALID_SEVERITY', `Unknown severity ${input.severity}`);
  const riskType = String(input.riskType ?? '').trim().toUpperCase();
  if (!RISK_TYPE_RE.test(riskType)) throw badRequest('INVALID_RISK_TYPE', 'riskType must be an UPPER_SNAKE identifier');
  const subjectId = String(input.subjectId ?? '').trim();
  if (!subjectId || subjectId.length > 200) throw badRequest('INVALID_SUBJECT_ID', 'subjectId is required (≤200 chars)');
  const raw = input.score ?? DEFAULT_SCORE[input.severity];
  const score = Math.min(100, Math.max(0, Math.round(Number.isFinite(raw) ? raw : DEFAULT_SCORE[input.severity])));
  const detail = sanitizeDetail(input.detail ?? {});

  const row = await maybeOne<{ id: string }>(
    db,
    `INSERT INTO risk_events(subject_type, subject_id, risk_type, severity, score, detail, dedupe_key, source_event_id, correlation_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [
      input.subjectType,
      subjectId,
      riskType,
      input.severity,
      score,
      JSON.stringify(detail),
      input.dedupeKey ?? null,
      input.sourceEventId ?? null,
      ctx.correlationId,
      ctx.actor?.userId ?? null,
    ],
  );
  if (!row) {
    const existing = await one<{ id: string }>(db, `SELECT id FROM risk_events WHERE dedupe_key = $1`, [input.dedupeKey]);
    return existing.id;
  }
  await emit(db, ctx, {
    aggregateType: 'risk_event',
    aggregateId: row.id,
    eventType: 'risk.detected',
    payload: { riskEventId: row.id, subjectType: input.subjectType, subjectId, riskType, severity: input.severity, score },
  });
  if (input.severity === 'HIGH' || input.severity === 'CRITICAL') {
    await notifyAdmins(db, ctx, {
      dedupeKey: `risk:${row.id}`,
      templateKey: 'security.risk_detected',
      title: `[보안] 위험 탐지 ${riskType} (${input.severity})`,
      body: `${input.subjectType} ${subjectId} · score ${score}. 관리자 콘솔에서 확인하세요.`,
      data: { riskEventId: row.id, riskType, severity: input.severity, subjectType: input.subjectType, subjectId },
    });
  }
  return row.id;
}

/** In-app + fan-out SECURITY notification to active ADMIN users (bounded). */
async function notifyAdmins(
  db: Db,
  ctx: Ctx,
  n: { dedupeKey: string; templateKey: string; title: string; body: string; data: Record<string, unknown>; exceptUserId?: string | null },
) {
  const admins = await q<{ id: string }>(
    db,
    `SELECT u.id FROM user_roles r JOIN users u ON u.id = r.user_id
      WHERE r.role = 'ADMIN' AND u.status = 'ACTIVE' AND ($1::uuid IS NULL OR u.id <> $1)
      ORDER BY u.id LIMIT 100`,
    [n.exceptUserId ?? null],
  );
  for (const a of admins) {
    await notify(db, ctx, { userId: a.id, templateKey: n.templateKey, category: 'SECURITY', title: n.title, body: n.body, data: n.data, dedupeKey: n.dedupeKey });
  }
}

/** Aggregated risk of a subject in the last `windowMinutes`: sum of scores (false positives excluded), capped at 100. */
export async function riskScore(db: Db, subjectType: SubjectType, subjectId: string, windowMinutes = 60): Promise<number> {
  return (await riskSummary(db, subjectType, subjectId, windowMinutes)).score;
}

export function riskLevel(score: number): 'NONE' | Severity {
  if (score <= 0) return 'NONE';
  if (score < 30) return 'LOW';
  if (score < 60) return 'MEDIUM';
  if (score < 90) return 'HIGH';
  return 'CRITICAL';
}

export async function riskSummary(db: Db, subjectType: SubjectType, subjectId: string, windowMinutes = 60) {
  const minutes = Math.max(1, Math.min(60 * 24 * 90, Math.floor(windowMinutes)));
  const r = await one<{ total: number; n: number; max_rank: number | null }>(
    db,
    `SELECT coalesce(sum(score), 0)::int AS total, count(*)::int AS n,
            max(CASE severity WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'HIGH' THEN 3 WHEN 'CRITICAL' THEN 4 END) AS max_rank
       FROM risk_events
      WHERE subject_type = $1 AND subject_id = $2 AND status <> 'FALSE_POSITIVE'
        AND created_at > now() - make_interval(mins => $3)`,
    [subjectType, subjectId, minutes],
  );
  const score = Math.min(100, r.total);
  const maxSeverity = (Object.keys(SEVERITY_RANK) as Severity[]).find((s) => SEVERITY_RANK[s] === r.max_rank) ?? null;
  return { subjectType, subjectId, windowMinutes: minutes, score, level: riskLevel(score), eventCount: r.n, maxSeverity };
}

export interface RiskEventFilter {
  subjectType?: SubjectType;
  subjectId?: string;
  riskType?: string;
  severity?: Severity;
  status?: RiskStatus;
  since?: string;
  limit: number;
  cursor?: string;
}

/** Newest first, exact keyset pagination over (created_at, id). */
export async function listRiskEvents(db: Db, f: RiskEventFilter) {
  const c = decodeCursor(f.cursor);
  const rows = await q(
    db,
    `SELECT r.*, ${cursorColumns('r')} FROM risk_events r
      WHERE ($1::text IS NULL OR r.subject_type = $1) AND ($2::text IS NULL OR r.subject_id = $2)
        AND ($3::text IS NULL OR r.risk_type = $3) AND ($4::text IS NULL OR r.severity = $4)
        AND ($5::text IS NULL OR r.status = $5) AND ($6::timestamptz IS NULL OR r.created_at >= $6::timestamptz)
        AND ($7::timestamptz IS NULL OR (r.created_at, r.id) < ($7::timestamptz, $8::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $9`,
    [f.subjectType ?? null, f.subjectId ?? null, f.riskType ?? null, f.severity ?? null, f.status ?? null, f.since ?? null, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  const p = page(rows, f.limit);
  return { items: p.items.map(toRiskEventDto), nextCursor: p.nextCursor };
}

export async function getRiskEvent(db: Db, id: string) {
  const r = await maybeOne(db, `SELECT * FROM risk_events WHERE id = $1`, [id]);
  if (!r) throw notFound('Risk event');
  return toRiskEventDto(r);
}

/** Staff triage: OPEN ⇄ ACKNOWLEDGED → RESOLVED | FALSE_POSITIVE (reopen allowed). Audited (SECURITY). */
export async function changeRiskStatus(tx: Tx, ctx: Ctx, id: string, args: { status: RiskStatus; note?: string }) {
  const before = await maybeOne(tx, `SELECT * FROM risk_events WHERE id = $1 FOR UPDATE`, [id]);
  if (!before) throw notFound('Risk event');
  const closing = args.status === 'RESOLVED' || args.status === 'FALSE_POSITIVE';
  const set: Record<string, unknown> = closing
    ? { resolved_by: ctx.actor?.userId ?? null, resolved_at: new Date(), resolution_note: args.note ?? null }
    : { resolved_by: null, resolved_at: null, resolution_note: args.status === 'OPEN' ? null : before.resolution_note };
  const { row } = await riskEventFsm.transition(tx, ctx, {
    table: 'risk_events',
    id,
    to: args.status,
    reason: args.note ?? `risk event ${before.status} → ${args.status}`,
    actorType: 'ADMIN',
    set,
  });
  await audit(tx, ctx, {
    action: 'risk_event.status_changed',
    resourceType: 'risk_event',
    resourceId: id,
    before: { status: before.status },
    after: { status: row.status },
    reason: args.note ?? null,
    category: 'SECURITY',
  });
  await emit(tx, ctx, {
    aggregateType: 'risk_event',
    aggregateId: id,
    eventType: 'risk.status_changed',
    payload: { riskEventId: id, from: before.status, to: row.status, actorId: ctx.actor?.userId ?? null },
  });
  return toRiskEventDto(row);
}

/** Staff-flagged risk (risk_type MANUAL unless given). Audited (SECURITY). */
export async function flagRiskManually(
  tx: Tx,
  ctx: Ctx,
  args: { subjectType: SubjectType; subjectId: string; riskType?: string; severity: Severity; score?: number; reason: string; detail?: Record<string, unknown> },
) {
  const id = await recordRiskEvent(tx, ctx, {
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    riskType: args.riskType ?? 'MANUAL',
    severity: args.severity,
    score: args.score,
    detail: { ...(args.detail ?? {}), reason: args.reason },
  });
  await audit(tx, ctx, {
    action: 'risk_event.flagged',
    resourceType: 'risk_event',
    resourceId: id,
    after: { subjectType: args.subjectType, subjectId: args.subjectId, riskType: args.riskType ?? 'MANUAL', severity: args.severity },
    reason: args.reason,
    category: 'SECURITY',
  });
  return getRiskEvent(tx, id);
}

// ------------------------------------------------------------------------------------------------ incidents

async function assertResponder(db: Db, userId: string) {
  const u = await maybeOne<{ ok: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ANY($2::text[])) AS ok
       FROM users u WHERE u.id = $1 AND u.status = 'ACTIVE'`,
    [userId, RESPONDER_ROLES],
  );
  if (!u?.ok) throw unprocessable('INVALID_COMMANDER', 'The incident commander must be an active ADMIN/COMPLIANCE/SUPPORT user');
}

async function assertRiskEventsExist(db: Db, ids: string[]) {
  if (!ids.length) return;
  const r = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM risk_events WHERE id = ANY($1::uuid[])`, [ids]);
  if (r.n !== ids.length) throw unprocessable('RISK_EVENT_NOT_FOUND', 'One or more related risk events do not exist');
}

async function timeline(
  tx: Tx,
  ctx: Ctx,
  incidentId: string,
  e: { type: string; fromStatus?: string | null; toStatus?: string | null; note?: string | null; data?: Record<string, unknown> },
) {
  return one(
    tx,
    `INSERT INTO security_incident_events(incident_id, event_type, from_status, to_status, note, data, actor_id, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [incidentId, e.type, e.fromStatus ?? null, e.toStatus ?? null, e.note ?? null, JSON.stringify(e.data ?? {}), ctx.actor?.userId ?? null, ctx.correlationId],
  );
}

async function incidentEvent(tx: Tx, ctx: Ctx, inc: any, action: string, extra: Record<string, unknown> = {}) {
  await emit(tx, ctx, {
    aggregateType: 'security_incident',
    aggregateId: inc.id,
    eventType: 'security.incident',
    payload: { incidentId: inc.id, action, status: inc.status, severity: inc.severity, actorId: ctx.actor?.userId ?? null, ...extra },
  });
}

async function notifyCommander(tx: Tx, ctx: Ctx, inc: any) {
  if (!inc.commander_id || inc.commander_id === ctx.actor?.userId) return;
  await notify(tx, ctx, {
    userId: inc.commander_id,
    templateKey: 'security.incident_assigned',
    category: 'SECURITY',
    title: `[보안] 인시던트 지휘 배정 (${inc.severity})`,
    body: `${inc.title}`.slice(0, 200),
    data: { incidentId: inc.id, severity: inc.severity },
    dedupeKey: `incident-commander:${inc.id}:${inc.commander_id}`,
  });
}

export async function openIncident(
  tx: Tx,
  ctx: Ctx,
  args: { title: string; severity: IncidentSeverity; summary?: string; commanderId?: string; relatedRiskEventIds?: string[] },
) {
  const actorId = ctx.actor?.userId;
  if (!actorId) throw badRequest('ACTOR_REQUIRED', 'An authenticated responder is required');
  const related = Array.from(new Set(args.relatedRiskEventIds ?? []));
  if (args.commanderId) await assertResponder(tx, args.commanderId);
  await assertRiskEventsExist(tx, related);
  const inc = await one(
    tx,
    `INSERT INTO security_incidents(title, severity, summary, commander_id, related_risk_event_ids, opened_by)
     VALUES ($1,$2,$3,$4,$5::uuid[],$6) RETURNING *`,
    [args.title.trim(), args.severity, args.summary ?? null, args.commanderId ?? null, related, actorId],
  );
  await timeline(tx, ctx, inc.id, { type: 'OPENED', toStatus: 'OPEN', note: args.summary ?? null, data: { severity: inc.severity, commanderId: inc.commander_id, relatedRiskEventIds: related } });
  await audit(tx, ctx, { action: 'security_incident.opened', resourceType: 'security_incident', resourceId: inc.id, after: toIncidentDto(inc), category: 'SECURITY' });
  await incidentEvent(tx, ctx, inc, 'OPENED');
  // PLAT-04 (AsyncAPI `incident.opened`): ops/SRE tooling subscribes to every incident kind
  await emit(tx, ctx, {
    aggregateType: 'security_incident',
    aggregateId: inc.id,
    eventType: 'incident.opened',
    payload: { incidentId: inc.id, kind: 'SECURITY', severity: inc.severity, commanderId: inc.commander_id ?? null, openedBy: actorId },
  });
  await notifyCommander(tx, ctx, inc);
  if (inc.severity === 'SEV1' || inc.severity === 'SEV2') {
    await notifyAdmins(tx, ctx, {
      dedupeKey: `incident:${inc.id}:opened`,
      templateKey: 'security.incident_opened',
      title: `[보안] ${inc.severity} 인시던트 발생`,
      body: `${inc.title}`.slice(0, 200),
      data: { incidentId: inc.id, severity: inc.severity },
      exceptUserId: actorId,
    });
  }
  return toIncidentDto(inc);
}

export async function listIncidents(db: Db, f: { status?: IncidentStatus; severity?: IncidentSeverity; active?: boolean; limit: number; cursor?: string }) {
  const c = decodeCursor(f.cursor);
  const rows = await q(
    db,
    `SELECT i.*, i.opened_at AS created_at, ${cursorColumns('i', 'opened_at')} FROM security_incidents i
      WHERE ($1::text IS NULL OR i.status = $1) AND ($2::text IS NULL OR i.severity = $2)
        AND ($3::boolean IS NOT TRUE OR i.status NOT IN ('RESOLVED','POSTMORTEM_DONE'))
        AND ($4::timestamptz IS NULL OR (i.opened_at, i.id) < ($4::timestamptz, $5::uuid))
      ORDER BY i.opened_at DESC, i.id DESC LIMIT $6`,
    [f.status ?? null, f.severity ?? null, f.active ?? false, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  const p = page(rows, f.limit);
  return { items: p.items.map(toIncidentDto), nextCursor: p.nextCursor };
}

export async function getIncident(db: Db, id: string) {
  const inc = await maybeOne(db, `SELECT * FROM security_incidents WHERE id = $1`, [id]);
  if (!inc) throw notFound('Security incident');
  const events = await q(db, `SELECT * FROM security_incident_events WHERE incident_id = $1 ORDER BY created_at, id`, [id]);
  return { item: toIncidentDto(inc), events: events.map(toIncidentEventDto) };
}

export type IncidentEventInput =
  | { type: 'NOTE'; note: string }
  | { type: 'STATUS_CHANGE'; status: IncidentStatus; note?: string; postmortemUrl?: string }
  | { type: 'SEVERITY_CHANGE'; severity: IncidentSeverity; note?: string }
  | { type: 'COMMANDER_CHANGE'; commanderId: string; note?: string }
  | { type: 'RISK_LINKED'; riskEventIds: string[]; note?: string };

/** Append a timeline entry; status/severity/commander/risk-link entries also change the incident. Audited (SECURITY). */
export async function addIncidentEvent(tx: Tx, ctx: Ctx, incidentId: string, e: IncidentEventInput) {
  const before = await maybeOne(tx, `SELECT * FROM security_incidents WHERE id = $1 FOR UPDATE`, [incidentId]);
  if (!before) throw notFound('Security incident');
  const closed = before.status === 'POSTMORTEM_DONE';
  if (closed && e.type !== 'NOTE') throw conflict('INCIDENT_CLOSED', 'The incident is closed (postmortem done); only notes can be added');
  let inc: any = before;
  let entry: any;
  switch (e.type) {
    case 'NOTE': {
      entry = await timeline(tx, ctx, incidentId, { type: 'NOTE', note: e.note });
      break;
    }
    case 'STATUS_CHANGE': {
      const set: Record<string, unknown> = {};
      const now = new Date();
      if (e.status === 'MITIGATED' && !before.mitigated_at) set.mitigated_at = now;
      if (e.status === 'RESOLVED') {
        set.resolved_at = now;
        if (!before.mitigated_at) set.mitigated_at = now;
      }
      if (e.status === 'INVESTIGATING' && before.resolved_at) set.resolved_at = null; // reopened
      if (e.postmortemUrl) set.postmortem_url = e.postmortemUrl;
      if (e.status === 'POSTMORTEM_DONE' && !(e.postmortemUrl ?? before.postmortem_url)) {
        throw unprocessable('POSTMORTEM_URL_REQUIRED', 'postmortemUrl is required to close an incident');
      }
      const t = await incidentFsm.transition(tx, ctx, {
        table: 'security_incidents',
        id: incidentId,
        to: e.status,
        reason: e.note ?? `incident ${before.status} → ${e.status}`,
        actorType: 'ADMIN',
        set,
        versioned: true,
      });
      inc = t.row;
      entry = await timeline(tx, ctx, incidentId, { type: 'STATUS_CHANGE', fromStatus: t.from, toStatus: t.to, note: e.note ?? null, data: e.postmortemUrl ? { postmortemUrl: e.postmortemUrl } : {} });
      break;
    }
    case 'SEVERITY_CHANGE': {
      if (e.severity === before.severity) throw conflict('NO_CHANGE', `The incident is already ${e.severity}`);
      inc = await one(tx, `UPDATE security_incidents SET severity = $2, version = version + 1 WHERE id = $1 RETURNING *`, [incidentId, e.severity]);
      entry = await timeline(tx, ctx, incidentId, { type: 'SEVERITY_CHANGE', note: e.note ?? null, data: { from: before.severity, to: e.severity } });
      break;
    }
    case 'COMMANDER_CHANGE': {
      await assertResponder(tx, e.commanderId);
      if (e.commanderId === before.commander_id) throw conflict('NO_CHANGE', 'This user is already the incident commander');
      inc = await one(tx, `UPDATE security_incidents SET commander_id = $2, version = version + 1 WHERE id = $1 RETURNING *`, [incidentId, e.commanderId]);
      entry = await timeline(tx, ctx, incidentId, { type: 'COMMANDER_CHANGE', note: e.note ?? null, data: { from: before.commander_id, to: e.commanderId } });
      await notifyCommander(tx, ctx, inc);
      break;
    }
    case 'RISK_LINKED': {
      const ids = Array.from(new Set(e.riskEventIds));
      await assertRiskEventsExist(tx, ids);
      inc = await one(
        tx,
        `UPDATE security_incidents
            SET related_risk_event_ids = ARRAY(SELECT DISTINCT x FROM unnest(related_risk_event_ids || $2::uuid[]) AS x ORDER BY x),
                version = version + 1
          WHERE id = $1 RETURNING *`,
        [incidentId, ids],
      );
      entry = await timeline(tx, ctx, incidentId, { type: 'RISK_LINKED', note: e.note ?? null, data: { riskEventIds: ids } });
      break;
    }
  }
  await audit(tx, ctx, {
    action: `security_incident.${e.type.toLowerCase()}`,
    resourceType: 'security_incident',
    resourceId: incidentId,
    before: e.type === 'NOTE' ? undefined : toIncidentDto(before),
    after: e.type === 'NOTE' ? { timelineEventId: entry.id } : toIncidentDto(inc),
    reason: 'note' in e ? e.note ?? null : null,
    category: 'SECURITY',
  });
  await incidentEvent(tx, ctx, inc, e.type, { timelineEventId: entry.id, fromStatus: before.status });
  return { event: toIncidentEventDto(entry), incident: toIncidentDto(inc) };
}
