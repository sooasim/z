import type { AppContext } from '../../platform/context.js';

/** COMMS-02 channel adapters. Providers never log message bodies or addresses (PII). */
export const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'KAKAO_ALIMTALK'] as const;
export type Channel = (typeof CHANNELS)[number];
export const EXTERNAL_CHANNELS: Channel[] = ['EMAIL', 'SMS', 'PUSH', 'KAKAO_ALIMTALK'];

export interface OutboundMessage {
  notificationId: string;
  channel: Channel;
  templateKey: string;
  category: string;
  to: { userId: string; email?: string | null; phone?: string | null; locale: string };
  subject?: string | null;
  body: string;
  data: Record<string, unknown>;
}

export interface Notifier {
  readonly name: string;
  send(msg: OutboundMessage): Promise<{ providerRef?: string | null }>;
}

/** Minimal transactional-email HTTP API contract (e.g. SES/Sendgrid/Postmark wrapper). */
export interface HttpEmailProvider {
  readonly name: string;
  sendEmail(m: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id?: string | null }>;
}

export class HttpEmailNotifier implements Notifier {
  readonly name: string;
  constructor(private provider: HttpEmailProvider) {
    this.name = `email:${provider.name}`;
  }
  async send(msg: OutboundMessage) {
    if (!msg.to.email) throw new Error('recipient has no email address');
    const r = await this.provider.sendEmail({ to: msg.to.email, subject: msg.subject ?? 'JETPOOL', text: msg.body, idempotencyKey: `${msg.notificationId}:${msg.channel}` });
    return { providerRef: r.id ?? null };
  }
}

/** Development provider: records a redacted line in the log, no delivery. */
export class LogProvider implements Notifier {
  readonly name = 'log';
  constructor(private app: Pick<AppContext, 'log'>) {}
  async send(msg: OutboundMessage) {
    this.app.log.info({ notificationId: msg.notificationId, channel: msg.channel, templateKey: msg.templateKey, userId: msg.to.userId }, 'notification (log provider)');
    return { providerRef: `log:${msg.notificationId}:${msg.channel}` };
  }
}

/** Novu: POST https://api.novu.co/v1/events/trigger — Novu workflows map templateKey → channel steps. */
export class NovuProvider implements Notifier {
  readonly name = 'novu';
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private baseUrl = 'https://api.novu.co',
  ) {}
  async send(msg: OutboundMessage) {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/events/trigger`, {
      method: 'POST',
      headers: { authorization: `ApiKey ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': `${msg.notificationId}:${msg.channel}` },
      body: JSON.stringify({
        name: msg.templateKey.replace(/[^a-z0-9-]/gi, '-'),
        to: { subscriberId: msg.to.userId, email: msg.to.email ?? undefined, phone: msg.to.phone ?? undefined, locale: msg.to.locale },
        payload: { subject: msg.subject, body: msg.body, channel: msg.channel, category: msg.category, ...msg.data },
        transactionId: `${msg.notificationId}:${msg.channel}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`novu responded ${res.status}`);
    const json: any = await res.json().catch(() => ({}));
    return { providerRef: json?.data?.transactionId ?? null };
  }
}

/** Channel → Notifier registry stored in app.ctx.adapters under 'notifier'. */
export class NotifierRegistry {
  private map = new Map<Channel, Notifier>();
  register(channel: Channel, n: Notifier) {
    this.map.set(channel, n);
    return this;
  }
  get(channel: Channel): Notifier | undefined {
    return this.map.get(channel);
  }
}

export function defaultRegistry(app: AppContext): NotifierRegistry {
  const reg = new NotifierRegistry();
  const log = new LogProvider(app);
  const novu = app.config.NOVU_API_KEY ? new NovuProvider(app.config.NOVU_API_KEY) : null;
  for (const ch of EXTERNAL_CHANNELS) reg.register(ch, novu ?? log);
  return reg;
}

export function getRegistry(app: AppContext): NotifierRegistry {
  let reg = app.adapters.get('notifier') as NotifierRegistry | undefined;
  if (!reg) {
    reg = defaultRegistry(app);
    app.adapters.set('notifier', reg);
  }
  return reg;
}
