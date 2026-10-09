import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { assertEnabled } from '../../platform/flags.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { StateMachine, recordTransition } from '../../platform/fsm.js';
import { cursorColumns, decodeCursor, idParams, isoDate, page, pagination } from '../../platform/http.js';

const TAG = 'JET-01';
export const CHARTER_FLAG = 'charter.direct_booking';

export const CharterLeadFSM = new StateMachine<'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CLOSED'>('charter_request', {
  NEW: ['CONTACTED', 'QUALIFIED', 'CLOSED'],
  CONTACTED: ['QUALIFIED', 'CLOSED'],
  QUALIFIED: ['CONTACTED', 'CLOSED'],
  CLOSED: [],
});

/** Default brand/IA content used until the CMS page `jetpool-charter` is published. */
export const DEFAULT_CHARTER_CONTENT = {
  slug: 'jetpool-charter',
  title: 'JETPOOL 전세기 · 플라이트 쉐어',
  summary: '프라이빗 전세기와 좌석 공유(플라이트 쉐어) 상담을 신청하세요. 현재는 상담·견적 요청만 받고 있으며 온라인 직접 예약·결제는 제공하지 않습니다.',
  bodyMd:
    '## 이렇게 진행됩니다\n\n1. 출발지·도착지·희망일·인원을 알려주세요.\n2. JETPOOL 컨시어지가 운항사 가용 여부와 예상 견적을 안내합니다.\n3. 계약과 결제는 승인된 운항사와 별도로 진행됩니다.\n\n> 온라인 전세기 직접 예약·결제 기능은 사업/법률 검토 승인 전까지 제공되지 않습니다.',
  sections: [
    { key: 'private-charter', title: '프라이빗 전세기', body: '일정과 경로를 원하는 대로 설계하는 단독 운항 상담.' },
    { key: 'flight-share', title: '플라이트 쉐어', body: '같은 노선을 원하는 여행자와 좌석을 나누는 공유 운항 상담.' },
    { key: 'concierge', title: '컨시어지', body: '공항 의전, 숙소·가이드 연계까지 하나의 여행으로.' },
  ],
  cta: { label: '상담 신청', action: 'POST /v1/charter/requests' },
  directBooking: false,
  source: 'DEFAULT',
};

const leadDto = (r: any) => ({
  id: r.id,
  userId: r.user_id,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  origin: r.origin,
  destination: r.destination,
  preferredDate: r.preferred_date,
  partySize: r.party_size,
  message: r.message,
  status: r.status,
  adminNote: r.admin_note,
  assigneeId: r.assignee_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** JET-01 Legacy Charter / Flight Share Scope Gate — routes, event handlers and adapters are registered here. */
export default async function charterModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.get('/v1/content/charter', { schema: { summary: 'Published charter and flight-share content', tags: [TAG], querystring: z.object({ locale: z.string().max(10).default('ko-KR') }) } }, async (req) => {
    const entry = await maybeOne(
      pool,
      `SELECT slug, locale, title, summary, body_md, data, seo, published_at FROM cms_entries
        WHERE entry_type = 'PAGE' AND slug = 'jetpool-charter' AND status = 'PUBLISHED'
        ORDER BY (locale = $1) DESC, published_at DESC NULLS LAST LIMIT 1`,
      [req.query.locale],
    );
    const directBooking = await assertEnabled(pool, CHARTER_FLAG).then(
      () => true,
      () => false,
    );
    if (!entry) return { item: { ...DEFAULT_CHARTER_CONTENT, directBooking } };
    return {
      item: {
        slug: entry.slug,
        locale: entry.locale,
        title: entry.title,
        summary: entry.summary,
        bodyMd: entry.body_md,
        sections: entry.data?.sections ?? DEFAULT_CHARTER_CONTENT.sections,
        cta: entry.data?.cta ?? DEFAULT_CHARTER_CONTENT.cta,
        seo: entry.seo,
        publishedAt: entry.published_at,
        directBooking,
        source: 'CMS',
      },
    };
  });

  r.post(
    '/v1/charter/requests',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: [TAG],
        summary: 'Charter / flight-share lead capture (no payment)',
        body: z.object({
          contactName: z.string().trim().min(1).max(100),
          contactEmail: z.email().max(200),
          contactPhone: z.string().regex(/^[0-9+\-() ]{6,30}$/).optional(),
          origin: z.string().trim().min(2).max(100),
          destination: z.string().trim().min(2).max(100),
          preferredDate: isoDate.optional(),
          partySize: z.number().int().min(1).max(500),
          message: z.string().max(2000).optional(),
          /** honeypot: must stay empty */
          website: z.string().max(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const b = req.body;
      if (b.preferredDate && b.preferredDate < new Date().toISOString().slice(0, 10)) {
        throw new AppError(400, 'DATE_IN_PAST', 'preferredDate must not be in the past');
      }
      const row = await withTx(pool, async (tx) => {
        const lead = await one(
          tx,
          `INSERT INTO charter_requests(user_id, contact_name, contact_email, contact_phone, origin, destination, preferred_date, party_size, message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [req.actor?.userId ?? null, b.contactName, b.contactEmail, b.contactPhone ?? null, b.origin, b.destination, b.preferredDate ?? null, b.partySize, b.message ?? null],
        );
        await recordTransition(tx, ctx, { aggregateType: 'charter_request', aggregateId: lead.id, from: null, to: 'NEW', reason: 'SUBMITTED' });
        await emit(tx, ctx, {
          aggregateType: 'charter_request',
          aggregateId: lead.id,
          eventType: 'charter.requested',
          payload: { requestId: lead.id, origin: lead.origin, destination: lead.destination, partySize: lead.party_size, preferredDate: lead.preferred_date },
        });
        await audit(tx, ctx, { action: 'charter.request.created', resourceType: 'charter_request', resourceId: lead.id, after: { origin: lead.origin, destination: lead.destination, partySize: lead.party_size } });
        const admins = await q<{ user_id: string }>(tx, `SELECT user_id FROM user_roles WHERE role = 'ADMIN' ORDER BY granted_at LIMIT 20`);
        for (const a of admins) {
          await notify(tx, ctx, {
            userId: a.user_id,
            templateKey: 'charter.requested',
            category: 'SYSTEM',
            title: '새 전세기 상담 요청',
            body: `${lead.origin} → ${lead.destination} · ${lead.party_size}명`,
            data: { requestId: lead.id },
            dedupeKey: `charter.requested:${lead.id}`,
          });
        }
        return lead;
      });
      return reply.status(201).send({ item: { id: row.id, status: row.status, createdAt: row.created_at } });
    },
  );

  r.get('/v1/charter/requests/mine', { schema: { summary: 'List charter enquiries of the current user', tags: [TAG] }, preHandler: requireAuth }, async (req) => {
    const rows = await q(pool, `SELECT * FROM charter_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [getActor(req).userId]);
    return { items: rows.map((x) => ({ ...leadDto(x), adminNote: undefined, assigneeId: undefined })) };
  });

  // Scope gate: paid direct charter booking stays disabled (G9) — no booking logic beyond the gate.
  const gate = async (req: any) => {
    await assertEnabled(pool, CHARTER_FLAG, req.actor ? { userId: req.actor.userId, roles: req.actor.roles } : undefined);
    throw new AppError(501, 'NOT_IMPLEMENTED', 'Direct charter booking requires an approved release ADR and compliance approval');
  };
  r.post('/v1/charter/bookings', { schema: { tags: [TAG], summary: 'Paid direct charter booking (disabled: FEATURE_DISABLED)' } }, gate);
  r.post('/v1/charter/bookings/:id/pay', { schema: { tags: [TAG], params: idParams, summary: 'Paid direct charter booking payment (disabled)' } }, gate);
  r.post('/v1/charter/flight-shares/:id/seats', { schema: { tags: [TAG], params: idParams, summary: 'Flight-share seat purchase (disabled)' } }, gate);

  // ---- admin lead pipeline
  r.get(
    '/v1/admin/charter/requests',
    { schema: { summary: 'List charter enquiries', tags: [TAG], querystring: pagination.extend({ status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'CLOSED']).optional() }) }, preHandler: requireRole('ADMIN', 'SUPPORT') },
    async (req) => {
      const c = decodeCursor(req.query.cursor);
      const rows = await q(
        pool,
        `SELECT *, ${cursorColumns()} FROM charter_requests WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [req.query.status ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
      );
      const pg = page(rows, req.query.limit);
      return { items: pg.items.map(leadDto), nextCursor: pg.nextCursor };
    },
  );

  r.patch(
    '/v1/admin/charter/requests/:id',
    {
      schema: { summary: 'Update a charter enquiry',
        tags: [TAG],
        params: idParams,
        body: z.object({ status: z.enum(['CONTACTED', 'QUALIFIED', 'CLOSED']).optional(), adminNote: z.string().max(4000).optional(), assigneeId: z.uuid().nullable().optional() }),
      },
      preHandler: requireRole('ADMIN', 'SUPPORT'),
    },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool, async (tx) => {
        const before = await maybeOne(tx, `SELECT * FROM charter_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!before) throw notFound('Charter request');
        if (req.body.status && req.body.status !== before.status) {
          await CharterLeadFSM.transition(tx, ctx, { table: 'charter_requests', id: before.id, to: req.body.status, reason: 'ADMIN' });
        }
        const after = await one(
          tx,
          `UPDATE charter_requests SET admin_note = coalesce($2, admin_note), assignee_id = CASE WHEN $3::boolean THEN $4::uuid ELSE assignee_id END, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [before.id, req.body.adminNote ?? null, req.body.assigneeId !== undefined, req.body.assigneeId ?? null],
        );
        await audit(tx, ctx, { action: 'charter.request.update', resourceType: 'charter_request', resourceId: before.id, before: { status: before.status }, after: { status: after.status, assigneeId: after.assignee_id } });
        return after;
      });
      return { item: leadDto(row) };
    },
  );
}
