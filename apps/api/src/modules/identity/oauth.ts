import type { Config } from '../../platform/config.js';
import { badGateway, badRequest } from '../../platform/errors.js';

export const OAUTH_PROVIDERS = ['google', 'kakao', 'naver'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface OAuthProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName?: string | null;
}

export interface OAuthAdapter {
  authorizationUrl(args: { state: string; redirectUri: string; codeChallenge: string; nonce: string }): string;
  exchange(args: { code: string; redirectUri: string; codeVerifier: string; state: string }): Promise<OAuthProfile>;
}

interface ProviderSpec {
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  clientId?: string;
  clientSecret?: string;
  pkce: boolean;
  parse(json: any): OAuthProfile;
}

/** Real provider endpoints (authorization-code flow). Credentials come from config. */
export function providerSpecs(cfg: Config): Record<OAuthProvider, ProviderSpec> {
  return {
    google: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      clientId: cfg.GOOGLE_CLIENT_ID,
      clientSecret: cfg.GOOGLE_CLIENT_SECRET,
      pkce: true,
      parse: (j) => ({ subject: String(j.sub), email: j.email ?? null, emailVerified: j.email_verified === true, displayName: j.name ?? null }),
    },
    kakao: {
      authUrl: 'https://kauth.kakao.com/oauth/authorize',
      tokenUrl: 'https://kauth.kakao.com/oauth/token',
      userInfoUrl: 'https://kapi.kakao.com/v2/user/me',
      scope: 'account_email profile_nickname',
      clientId: cfg.KAKAO_CLIENT_ID,
      clientSecret: cfg.KAKAO_CLIENT_SECRET,
      pkce: true,
      parse: (j) => ({
        subject: String(j.id),
        email: j.kakao_account?.email ?? null,
        emailVerified: j.kakao_account?.is_email_valid === true && j.kakao_account?.is_email_verified === true,
        displayName: j.kakao_account?.profile?.nickname ?? j.properties?.nickname ?? null,
      }),
    },
    naver: {
      authUrl: 'https://nid.naver.com/oauth2.0/authorize',
      tokenUrl: 'https://nid.naver.com/oauth2.0/token',
      userInfoUrl: 'https://openapi.naver.com/v1/nid/me',
      scope: '',
      clientId: cfg.NAVER_CLIENT_ID,
      clientSecret: cfg.NAVER_CLIENT_SECRET,
      pkce: false,
      // Naver does not assert email verification in the profile API; treat as unverified.
      parse: (j) => ({ subject: String(j.response?.id), email: j.response?.email ?? null, emailVerified: false, displayName: j.response?.nickname ?? j.response?.name ?? null }),
    },
  };
}

function httpAdapter(provider: OAuthProvider, spec: ProviderSpec): OAuthAdapter {
  return {
    authorizationUrl({ state, redirectUri, codeChallenge, nonce }) {
      if (!spec.clientId) throw badRequest('OAUTH_NOT_CONFIGURED', `${provider} login is not configured`);
      const u = new URL(spec.authUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', spec.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      if (spec.scope) u.searchParams.set('scope', spec.scope);
      if (spec.pkce) {
        u.searchParams.set('code_challenge', codeChallenge);
        u.searchParams.set('code_challenge_method', 'S256');
      }
      if (provider === 'google') u.searchParams.set('nonce', nonce);
      return u.toString();
    },
    async exchange({ code, redirectUri, codeVerifier, state }) {
      if (!spec.clientId || !spec.clientSecret) throw badRequest('OAUTH_NOT_CONFIGURED', `${provider} login is not configured`);
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: spec.clientId,
        client_secret: spec.clientSecret,
      });
      if (spec.pkce) body.set('code_verifier', codeVerifier);
      if (provider === 'naver') body.set('state', state);
      let token: any;
      try {
        const res = await fetch(spec.tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        token = await res.json();
        if (!res.ok || !token.access_token) throw new Error(token.error_description ?? token.error ?? `HTTP ${res.status}`);
      } catch (e: any) {
        throw badGateway('OAUTH_EXCHANGE_FAILED', `${provider} token exchange failed`, { reason: String(e?.message ?? e).slice(0, 200) });
      }
      try {
        const res = await fetch(spec.userInfoUrl, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        const json = await res.json();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = spec.parse(json);
        if (!p.subject || p.subject === 'undefined') throw new Error('missing subject');
        return p;
      } catch (e: any) {
        throw badGateway('OAUTH_PROFILE_FAILED', `${provider} profile fetch failed`, { reason: String(e?.message ?? e).slice(0, 200) });
      }
    },
  };
}

/** Test/dev adapter: code = `mock:<subject>:<email>[:unverified]`. Rejected in production by loadConfig. */
function mockAdapter(provider: OAuthProvider): OAuthAdapter {
  return {
    authorizationUrl: ({ state, redirectUri }) => `https://mock-oauth.invalid/${provider}/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async exchange({ code }) {
      const m = /^mock:([^:]+):([^:]*)(:unverified)?$/.exec(code);
      if (!m) throw badRequest('OAUTH_CODE_INVALID', 'Invalid authorization code');
      return { subject: m[1], email: m[2] || null, emailVerified: !m[3], displayName: null };
    },
  };
}

export function oauthAdapter(cfg: Config, provider: OAuthProvider, registry?: Map<string, unknown>): OAuthAdapter {
  const custom = registry?.get(`oauth.${provider}`) as OAuthAdapter | undefined;
  if (custom) return custom;
  if (cfg.OAUTH_MOCK && cfg.NODE_ENV !== 'production') return mockAdapter(provider);
  return httpAdapter(provider, providerSpecs(cfg)[provider]);
}

export const oauthRedirectUri = (cfg: Config, provider: OAuthProvider) => `${cfg.PUBLIC_WEB_URL.replace(/\/$/, '')}/auth/callback/${provider}`;
