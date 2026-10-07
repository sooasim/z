import type { Db } from '../../platform/db.js';
import { maybeOne, one } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { notFound } from '../../platform/errors.js';
import { parseIntentRuleBased, type TravelIntent } from './intent.js';
import { searchGuides, searchStays, searchTravelProducts, type Suggestion } from './search.js';
import { ClaudeAssistantLlm, type AssistantLlm } from './llm.js';

export const RULE_BASED_MODEL = 'rule-based-v1';
const MAX_HISTORY = 20;

export function getLlm(app: AppContext): AssistantLlm | null {
  const injected = app.adapters.get('ai.llm') as AssistantLlm | undefined;
  if (injected) return injected;
  if (!app.config.ANTHROPIC_API_KEY) return null;
  const llm = new ClaudeAssistantLlm(app.config.ANTHROPIC_API_KEY, app.config.AI_MODEL);
  app.adapters.set('ai.llm', llm);
  return llm;
}

const todayIn = (tz = 'Asia/Seoul') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function templateReply(intent: TravelIntent, suggestions: Suggestion[]): string {
  const ko = intent.language === 'ko';
  const parts: string[] = [];
  const where = intent.destination?.city;
  const when = intent.checkIn && intent.checkOut ? `${intent.checkIn}~${intent.checkOut}` : null;
  if (ko) {
    parts.push(`${where ? `${where} ` : ''}${when ? `${when} ` : ''}${intent.guests ? `${intent.guests}명 ` : ''}조건으로 실시간 검색했어요.`);
    parts.push(suggestions.length ? `${suggestions.length}개의 추천을 찾았습니다. 각 추천의 근거와 확인 시각을 함께 보여드려요.` : '조건에 맞는 예약 가능한 항목을 찾지 못했어요. 날짜나 지역을 바꿔 보시겠어요?');
    if (!when && intent.modes.includes('stay')) parts.push('정확한 예약 가능 여부를 확인하려면 날짜를 알려주세요.');
    parts.push('아무것도 예약되지 않았습니다. 마음에 드는 항목을 열어 직접 확인 후 진행해 주세요.');
  } else {
    parts.push(`I searched live listings${where ? ` in ${intent.destination?.aliases[1] ?? where}` : ''}${when ? ` for ${when}` : ''}${intent.guests ? ` for ${intent.guests} guests` : ''}.`);
    parts.push(suggestions.length ? `Here are ${suggestions.length} suggestions, each with the reasons it matched and when availability was checked.` : 'Nothing bookable matched. Try other dates or another area?');
    if (!when && intent.modes.includes('stay')) parts.push('Share your dates so I can check real availability.');
    parts.push('Nothing has been booked — open a suggestion and confirm it yourself.');
  }
  return parts.join(' ');
}

export interface AssistantResult {
  sessionId: string;
  recommendationId: string;
  model: string;
  intent: TravelIntent;
  reply: string;
  suggestions: Suggestion[];
  availabilitySnapshotAt: string;
  requiresUserConfirmation: true;
  disclaimer: string;
}

/**
 * AI-01: parse intent → live read-only search → explainable suggestions. NEVER creates holds, payments or
 * bookings (explicit user confirmation required); persists the session and the recommendation snapshot.
 */
export async function runTravelAssistant(db: Db, ctx: Ctx, args: { userId: string; message: string; sessionId?: string }): Promise<AssistantResult> {
  const app = ctx.app;
  if (args.sessionId) {
    const s = await maybeOne(db, `SELECT id FROM ai_sessions WHERE id = $1 AND user_id = $2`, [args.sessionId, args.userId]);
    if (!s) throw notFound('Assistant session');
  }
  const today = todayIn();
  const ruleIntent = parseIntentRuleBased(args.message, today);
  const llm = getLlm(app);
  let intent = ruleIntent;
  let model = RULE_BASED_MODEL;
  if (llm) {
    try {
      intent = await llm.extractIntent(args.message, today, ruleIntent);
      model = llm.model;
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'ai intent extraction failed; using rule-based parser');
    }
  }

  const snapshotAt = new Date().toISOString();
  const per = 3;
  const suggestions: Suggestion[] = [];
  for (const mode of intent.modes) {
    if (mode === 'stay' || mode === 'exchange') suggestions.push(...(await searchStays(db, intent, { userId: args.userId, snapshotAt, mode, limit: per })));
    if (mode === 'guide') suggestions.push(...(await searchGuides(db, intent, { userId: args.userId, snapshotAt, limit: per })));
    if (mode === 'travel') suggestions.push(...(await searchTravelProducts(db, intent, { userId: args.userId, snapshotAt, limit: per })));
  }

  let reply = templateReply(intent, suggestions);
  if (llm && model !== RULE_BASED_MODEL) {
    try {
      reply = await llm.phrase(args.message, intent, suggestions);
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'ai phrasing failed; using template reply');
    }
  }

  const now = new Date().toISOString();
  const session = args.sessionId
    ? await one<{ id: string }>(
        db,
        `UPDATE ai_sessions SET messages = (SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb) FROM (
             SELECT e, ord FROM jsonb_array_elements(messages || $2::jsonb) WITH ORDINALITY AS t(e, ord)
             ORDER BY ord DESC LIMIT ${MAX_HISTORY}) x), updated_at = now()
          WHERE id = $1 RETURNING id`,
        [args.sessionId, JSON.stringify([{ role: 'user', content: args.message.slice(0, 2000), at: now }])],
      )
    : await one<{ id: string }>(db, `INSERT INTO ai_sessions(user_id, messages) VALUES ($1,$2) RETURNING id`, [args.userId, JSON.stringify([{ role: 'user', content: args.message.slice(0, 2000), at: now }])]);
  const rec = await one<{ id: string }>(
    db,
    `INSERT INTO ai_recommendations(session_id, user_id, intent, items, availability_snapshot_at, model) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [session.id, args.userId, JSON.stringify(intent), JSON.stringify(suggestions), snapshotAt, model],
  );
  await db.query(`UPDATE ai_sessions SET messages = messages || $2::jsonb WHERE id = $1`, [
    session.id,
    JSON.stringify([{ role: 'assistant', content: reply, recommendationId: rec.id, at: new Date().toISOString() }]),
  ]);
  await emit(db, ctx, {
    aggregateType: 'ai_recommendation',
    aggregateId: rec.id,
    eventType: 'ai.recommendation.created',
    payload: { recommendationId: rec.id, sessionId: session.id, userId: args.userId, model, itemCount: suggestions.length, modes: intent.modes, availabilitySnapshotAt: snapshotAt },
  });
  return {
    sessionId: session.id,
    recommendationId: rec.id,
    model,
    intent,
    reply,
    suggestions,
    availabilitySnapshotAt: snapshotAt,
    requiresUserConfirmation: true,
    disclaimer:
      intent.language === 'ko'
        ? 'AI 추천은 참고용이며 예약·결제는 자동으로 진행되지 않습니다. 가격과 가능 여부는 확인 시점 기준이며 예약 단계에서 다시 확인됩니다.'
        : 'Suggestions are informational; nothing is booked or charged automatically. Prices and availability are as of the snapshot time and are re-checked at booking.',
  };
}
