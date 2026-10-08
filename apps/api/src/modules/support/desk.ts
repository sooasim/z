import type { AppContext } from '../../platform/context.js';

/**
 * OPS-01 external support desk adapter (Chatwoot-backed intake).
 *
 * PostgreSQL stays the source of truth for the case (invariant 1); the desk only mirrors it as a conversation
 * so agents can work in their tool. Privacy: requester contact data (email/phone) is NOT sent to the desk —
 * the contact is keyed by an opaque JETPOOL identifier, so OPS-01 masking cannot be bypassed via the desk.
 */
export interface SupportDeskCase {
  id: string;
  requesterId: string | null;
  category: string;
  subject: string;
  description: string;
  priority: string;
  contextType: string | null;
  contextId: string | null;
}

export interface SupportDesk {
  readonly name: string;
  /** Create the desk conversation for a case. Returns null when the desk is disabled (no-op). */
  createConversation(c: SupportDeskCase): Promise<{ externalRef: string } | null>;
}

export const SUPPORT_DESK_ADAPTER = 'support.desk';

export class NoopSupportDesk implements SupportDesk {
  readonly name = 'noop';
  async createConversation(): Promise<null> {
    return null;
  }
}

export interface ChatwootConfig {
  baseUrl: string;
  apiToken: string;
  accountId: string;
  inboxId: string;
  /** injectable for tests; defaults to global fetch */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class SupportDeskError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
  }
}

const PRIORITY_MAP: Record<string, string> = { LOW: 'low', NORMAL: 'medium', HIGH: 'high', URGENT: 'urgent' };

/** Chatwoot Application API (https://www.chatwoot.com/developers/api/). Auth: `api_access_token` header. */
export class ChatwootSupportDesk implements SupportDesk {
  readonly name = 'chatwoot';
  private readonly base: string;

  constructor(private readonly cfg: ChatwootConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
  }

  private get account() {
    return encodeURIComponent(this.cfg.accountId);
  }

  private async req<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const f = this.cfg.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        method,
        headers: { api_access_token: this.cfg.apiToken, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (err: any) {
      // never include the token or request body in errors/logs
      throw new SupportDeskError(`chatwoot ${method} ${path.split('?')[0]} failed: ${err?.name ?? 'network error'}`, null);
    }
    if (!res.ok) throw new SupportDeskError(`chatwoot ${method} ${path.split('?')[0]} returned ${res.status}`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private sourceIdFor(contact: any): string | null {
    const inboxes: any[] = contact?.contact_inboxes ?? [];
    const hit = inboxes.find((ci) => String(ci?.inbox?.id ?? ci?.inbox_id) === String(this.cfg.inboxId));
    return hit?.source_id ?? null;
  }

  /** Find-or-create the contact by opaque identifier and make sure it has a contact_inbox in our inbox. */
  private async ensureContact(identifier: string, name: string): Promise<{ contactId: string; sourceId: string; existed: boolean }> {
    const found = await this.req('GET', `/api/v1/accounts/${this.account}/contacts/search?q=${encodeURIComponent(identifier)}`);
    let contact: any = (found?.payload ?? []).find((c: any) => c?.identifier === identifier) ?? null;
    const existed = !!contact;
    let sourceId: string | null = null;
    if (!contact) {
      const created = await this.req('POST', `/api/v1/accounts/${this.account}/contacts`, { inbox_id: Number(this.cfg.inboxId) || this.cfg.inboxId, name, identifier });
      contact = created?.payload?.contact ?? created?.payload ?? created;
      sourceId = created?.payload?.contact_inbox?.source_id ?? null;
    }
    if (!contact?.id) throw new SupportDeskError('chatwoot contact response without id', null);
    sourceId ??= this.sourceIdFor(contact);
    if (!sourceId) {
      const ci = await this.req('POST', `/api/v1/accounts/${this.account}/contacts/${encodeURIComponent(String(contact.id))}/contact_inboxes`, {
        inbox_id: Number(this.cfg.inboxId) || this.cfg.inboxId,
      });
      sourceId = ci?.source_id ?? null;
    }
    if (!sourceId) throw new SupportDeskError('chatwoot contact_inbox without source_id', null);
    return { contactId: String(contact.id), sourceId, existed };
  }

  /** A conversation already mirrored for this case (a previous attempt whose response or store was lost). */
  private async existingConversation(contactId: string, caseId: string): Promise<string | null> {
    const res = await this.req('GET', `/api/v1/accounts/${this.account}/contacts/${encodeURIComponent(contactId)}/conversations`);
    const list: any[] = Array.isArray(res?.payload) ? res.payload : Array.isArray(res) ? res : [];
    const hit = list.find((cv) => cv?.custom_attributes?.jetpool_case_id === caseId || cv?.additional_attributes?.jetpool_case_id === caseId);
    return hit?.id !== undefined && hit?.id !== null ? String(hit.id) : null;
  }

  async createConversation(c: SupportDeskCase): Promise<{ externalRef: string }> {
    const identifier = c.requesterId ? `jetpool:user:${c.requesterId}` : `jetpool:case:${c.id}`;
    const { contactId, sourceId, existed } = await this.ensureContact(identifier, c.requesterId ? `JETPOOL user ${c.requesterId.slice(0, 8)}` : 'JETPOOL guest');
    // idempotent create: a brand-new contact has no conversations; an existing one may already have this case
    const prior = existed ? await this.existingConversation(contactId, c.id) : null;
    if (prior) return { externalRef: `chatwoot:${this.cfg.accountId}:${prior}` };
    const conv = await this.req('POST', `/api/v1/accounts/${this.account}/conversations`, {
      source_id: sourceId,
      inbox_id: Number(this.cfg.inboxId) || this.cfg.inboxId,
      contact_id: Number(contactId) || contactId,
      status: 'open',
      priority: PRIORITY_MAP[c.priority] ?? 'medium',
      additional_attributes: { jetpool_case_id: c.id },
      custom_attributes: { jetpool_case_id: c.id, category: c.category, priority: c.priority, context_type: c.contextType, context_id: c.contextId },
      message: { content: `[${c.category}] ${c.subject}\n\n${c.description}`.slice(0, 10_000) },
    });
    const id = conv?.id ?? conv?.payload?.id;
    if (id === undefined || id === null) throw new SupportDeskError('chatwoot conversation response without id', null);
    return { externalRef: `chatwoot:${this.cfg.accountId}:${id}` };
  }
}

/** CHATWOOT_BASE_URL / CHATWOOT_API_TOKEN / CHATWOOT_ACCOUNT_ID / CHATWOOT_INBOX_ID; null when incomplete. */
export function chatwootConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChatwootConfig | null {
  const baseUrl = env.CHATWOOT_BASE_URL?.trim();
  const apiToken = env.CHATWOOT_API_TOKEN?.trim();
  const accountId = env.CHATWOOT_ACCOUNT_ID?.trim();
  const inboxId = env.CHATWOOT_INBOX_ID?.trim();
  if (!baseUrl || !apiToken || !accountId || !inboxId) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  return { baseUrl, apiToken, accountId, inboxId };
}

/** Registered adapter (tests / custom wiring) wins; otherwise Chatwoot when configured, else no-op. */
export function supportDeskOf(app: Pick<AppContext, 'adapters'>): SupportDesk {
  const registered = app.adapters.get(SUPPORT_DESK_ADAPTER) as SupportDesk | undefined;
  if (registered) return registered;
  const cfg = chatwootConfigFromEnv();
  return cfg ? new ChatwootSupportDesk(cfg) : new NoopSupportDesk();
}
