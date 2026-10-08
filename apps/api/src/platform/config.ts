import { z } from 'zod';

/**
 * Boolean env var: 'true'/'1'/'yes'/'on' → true, 'false'/'0'/'no'/'off' → false (case-insensitive), unset or
 * blank → `fallback`; anything else fails config validation. Real booleans (test overrides) pass through.
 */
const envBoolean = (fallback: boolean) =>
  z.preprocess((v) => (typeof v === 'boolean' ? String(v) : typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v), z.stringbool().default(fallback));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/jetpool'),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  JWT_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-0123456789'),
  JWT_ISSUER: z.string().default('jetpool'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().default(60 * 60 * 24 * 30),
  /** 32-byte hex key for encrypting MFA secrets at rest */
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/).default('0'.repeat(64)),
  PUBLIC_WEB_URL: z.string().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(600),
  /**
   * Which hops may set X-Forwarded-For (req.ip feeds rate limits, sessions.ip, audit and consent evidence).
   * Comma-separated addresses/CIDRs or proxy-addr names (loopback, linklocal, uniquelocal), a hop count, or
   * 'true'/'false'. Default: only private-network proxies (k8s ingress / Fly proxy / BFF), so a client cannot
   * pick its own IP by sending the header; set explicitly when a public CDN terminates in front of the API.
   */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  // Payments (PAY-01). provider MOCK is rejected in production.
  PAYMENT_PROVIDER: z.enum(['TOSS', 'MOCK']).default('MOCK'),
  TOSS_SECRET_KEY: z.string().optional(),
  TOSS_CLIENT_KEY: z.string().optional(),
  TOSS_API_BASE: z.string().default('https://api.tosspayments.com'),
  TOSS_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_TTL_SEC: z.coerce.number().default(15 * 60),
  HOLD_TTL_SEC: z.coerce.number().default(15 * 60),
  QUOTE_TTL_SEC: z.coerce.number().default(30 * 60),
  // OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  KAKAO_CLIENT_ID: z.string().optional(),
  KAKAO_CLIENT_SECRET: z.string().optional(),
  NAVER_CLIENT_ID: z.string().optional(),
  NAVER_CLIENT_SECRET: z.string().optional(),
  // strict: z.coerce.boolean() is Boolean(str), so the deployed OAUTH_MOCK="false" (k8s/terraform) meant TRUE
  OAUTH_MOCK: envBoolean(false),
  // Storage (STAY-02)
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('ap-northeast-2'),
  S3_BUCKET_PRIVATE: z.string().default('jetpool-private'),
  S3_BUCKET_PUBLIC: z.string().default('jetpool-public'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  CDN_BASE_URL: z.string().default('http://localhost:4000/media-dev'),
  // Search (PLAT-01). Optional; Postgres fallback is used when unset.
  MEILI_HOST: z.string().optional(),
  MEILI_API_KEY: z.string().optional(),
  // Notifications (COMMS-02)
  NOVU_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  // AI (AI-01)
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
  // Geo (PLAT-02)
  GEOCODER: z.enum(['NOMINATIM', 'KAKAO', 'STATIC']).default('STATIC'),
  KAKAO_REST_API_KEY: z.string().optional(),
  /** Secret key for the public-coordinate privacy fuzz (>= 32 chars). Unset → derived from DATA_ENCRYPTION_KEY. */
  GEO_FUZZ_SECRET: z.string().min(32).optional(),
  // Workers
  OUTBOX_POLL_MS: z.coerce.number().default(1000),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const cfg = schema.parse({ ...process.env, ...overrides });
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (cfg.DATA_ENCRYPTION_KEY === '0'.repeat(64)) throw new Error('DATA_ENCRYPTION_KEY must be set in production');
    if (cfg.PAYMENT_PROVIDER === 'MOCK') throw new Error('MOCK payment provider is forbidden in production');
    if (cfg.OAUTH_MOCK) throw new Error('OAUTH_MOCK is forbidden in production');
  }
  return cfg;
}
