import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { SUPPORTED_LOCALES, translationDeps, type SupportedLocale } from '../../platform/content-locale.js';
import { translatable, translateMany, translateNow } from '../../platform/translate.js';
import { NOTIFY_CHANNEL, type MessageRow } from './service.js';

/**
 * COMMS-01 cross-language messaging.
 *
 * A conversation between a Korean host and a Vietnamese traveller only works if each side reads the other in
 * their own language while still being able to see what was actually written — a mistranslated price or date
 * has to be checkable against the original. So nothing here ever replaces a message body: the original stays
 * authoritative (AGENTS_MASTER invariant 1) and a translation rides alongside it.
 *
 * Timing is the whole design problem. A message is new text by definition, so the cache-only read path that
 * serves listings would never have anything for it. Instead the outbox handler below translates right after the
 * message commits, into the languages this conversation's members actually read, and re-notifies so open
 * clients get the translation pushed to them a moment after the original. That keeps `POST /messages` as fast
 * as it was — the sender never waits for a translator — while the recipient still gets both halves.
 */

const SUPPORTED = new Set<string>(SUPPORTED_LOCALES);

/** A member's account language, normalised to a locale this product translates into. */
export function readerLocale(raw: string | null | undefined): SupportedLocale | null {
  if (!raw) return null;
  if (SUPPORTED.has(raw)) return raw as SupportedLocale;
  // users.locale allows a bare primary subtag ('vi'); match it the way contentLocale does.
  const primary = raw.toLowerCase().split('-')[0];
  return (SUPPORTED_LOCALES.find((l) => l.split('-')[0] === primary) as SupportedLocale | undefined) ?? null;
}

/**
 * The languages a message has to exist in for this conversation: every member's account language except the
 * one it was written in. Staff reading under elevated access are deliberately not members, so they do not
 * widen the set — their read uses whatever is already cached.
 */
export async function targetLocalesFor(db: Db, conversationId: string, sourceLocale: string | null): Promise<SupportedLocale[]> {
  const rows = await q<{ locale: string | null }>(
    db,
    `SELECT DISTINCT u.locale FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = $1`,
    [conversationId],
  );
  const out = new Set<SupportedLocale>();
  for (const r of rows) {
    const l = readerLocale(r.locale);
    if (l && l !== sourceLocale) out.add(l);
  }
  return [...out];
}

/**
 * Translate one committed message into every language its conversation needs, filling `content_translations`.
 * Returns the locales actually written, so the caller can skip the re-notify when there was nothing to do.
 *
 * Runs inside the outbox handler's transaction on purpose: an afterCommit callback that fails is only logged,
 * and a translation that is silently lost leaves the recipient staring at a language they do not read. Inside
 * the transaction a provider error retries the event instead. The only locks held are on a cache table whose
 * writes are `ON CONFLICT DO NOTHING`, so the cost of holding them across the HTTP call is negligible.
 */
export async function translateMessage(app: AppContext, ctx: Ctx, db: Db, msg: MessageRow): Promise<SupportedLocale[]> {
  if (msg.redacted_at || !translatable(msg.body)) return [];
  const deps = await translationDeps(ctx);
  if (!deps?.translator) return [];
  const targets = await targetLocalesFor(db, msg.conversation_id, readerLocale(msg.source_locale));
  const written: SupportedLocale[] = [];
  for (const locale of targets) {
    const map = await translateNow({ db, translator: deps.translator }, [msg.body], locale);
    if (map.has(msg.body)) written.push(locale);
  }
  if (written.length) {
    // Same channel the send path uses: the bridge re-reads the row and re-delivers it, now with translations.
    await db.query(`SELECT pg_notify($1, $2)`, [NOTIFY_CHANNEL, JSON.stringify({ messageId: msg.id, conversationId: msg.conversation_id, translated: true })]);
  }
  app.log?.debug?.({ messageId: msg.id, locales: written }, 'message translated');
  return written;
}

/**
 * Cached translations of `bodies` into `locale`, for the read and realtime paths. Cache-only: a reader never
 * waits for a provider. Misses are queued, which covers the gap when someone reads in a language no member of
 * the conversation has set as their account language (a guest switching the UI language mid-thread).
 */
export async function cachedTranslations(ctx: Ctx, bodies: readonly string[], locale: SupportedLocale): Promise<Map<string, string>> {
  const deps = await translationDeps(ctx);
  if (!deps) return new Map();
  return translateMany(deps, bodies, locale);
}
