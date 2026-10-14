import { describe, expect, it } from 'vitest';
import {
  APP_INSTALL_PATH,
  androidChromeIntent,
  detectEnv,
  escapeTarget,
  installPlan,
  isStandalone,
  kakaoOpenExternal,
  type AppEnv,
} from '@/lib/inapp';

/** Real user-agent strings — the whole module is pattern matching, so fabricated ones would prove nothing. */
const UA = {
  kakaoAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-S918N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36;KAKAOTALK 2510230',
  kakaoIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.5',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  safariIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  naverIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.4.5)',
  instagramAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A536N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 310.0.0.26.113 Android',
  lineIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/14.2.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};

describe('in-app browser detection', () => {
  it('names the WebView the reader is stuck in', () => {
    expect(detectEnv({ userAgent: UA.kakaoAndroid })).toEqual({ os: 'android', inApp: 'kakaotalk' });
    expect(detectEnv({ userAgent: UA.kakaoIOS })).toEqual({ os: 'ios', inApp: 'kakaotalk' });
    expect(detectEnv({ userAgent: UA.naverIOS })).toEqual({ os: 'ios', inApp: 'naver' });
    expect(detectEnv({ userAgent: UA.instagramAndroid })).toEqual({ os: 'android', inApp: 'instagram' });
    expect(detectEnv({ userAgent: UA.lineIOS })).toEqual({ os: 'ios', inApp: 'line' });
  });
  it('leaves real browsers alone — a false positive would hide the one-tap install', () => {
    expect(detectEnv({ userAgent: UA.chromeAndroid })).toEqual({ os: 'android', inApp: null });
    expect(detectEnv({ userAgent: UA.safariIOS })).toEqual({ os: 'ios', inApp: null });
    expect(detectEnv({ userAgent: UA.samsungAndroid })).toEqual({ os: 'android', inApp: null });
    expect(detectEnv({ userAgent: UA.desktopChrome })).toEqual({ os: 'other', inApp: null });
  });
  it('reads iPadOS as iOS although its UA says Macintosh', () => {
    expect(detectEnv({ userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 }).os).toBe('ios');
    // A real Mac: same UA, no touch screen.
    expect(detectEnv({ userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 0 }).os).toBe('other');
  });
});

describe('escape URLs', () => {
  const target = 'https://jetpool.co.kr/app?install=1';

  it('builds the Chrome intent Android documents', () => {
    const intent = androidChromeIntent(target);
    expect(intent).toBe(
      'intent://jetpool.co.kr/app?install=1#Intent;scheme=https;action=android.intent.action.VIEW;' +
        'package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fjetpool.co.kr%2Fapp%3Finstall%3D1;end',
    );
  });
  it('keeps a fragment out of the intent separator and rejects a non-web scheme', () => {
    expect(androidChromeIntent('https://jetpool.co.kr/app#app-install')).toContain('intent://jetpool.co.kr/app%23app-install#Intent;');
    expect(() => androidChromeIntent('file:///etc/passwd')).toThrow(/unsupported scheme/);
  });
  it('encodes the target into KakaoTalk’s external scheme', () => {
    expect(kakaoOpenExternal(target)).toBe('kakaotalk://web/openExternal?url=https%3A%2F%2Fjetpool.co.kr%2Fapp%3Finstall%3D1');
  });
});

describe('escape target is never an open redirect', () => {
  const origin = 'https://jetpool.co.kr';
  it('resolves our own install path', () => {
    expect(escapeTarget(origin)).toBe('https://jetpool.co.kr/app?install=1');
    expect(APP_INSTALL_PATH).toBe('/app?install=1');
  });
  it('refuses to hand another origin, or a non-web scheme, to the external browser', () => {
    expect(() => escapeTarget(origin, 'https://phishing.example/login')).toThrow(/another origin/);
    expect(() => escapeTarget(origin, '//phishing.example/login')).toThrow(/another origin/);
    expect(() => escapeTarget(origin, 'javascript:alert(1)')).toThrow(/unsupported scheme/);
  });
});

describe('which install UI applies', () => {
  const env = (os: AppEnv['os'], inApp: AppEnv['inApp'] = null): AppEnv => ({ os, inApp });
  const plan = (e: AppEnv, standalone = false, promptReady = false) => installPlan(e, { standalone, promptReady });

  it('short-circuits once the app is installed', () => {
    expect(plan(env('android'), true, true)).toBe('installed');
    expect(plan(env('ios', 'kakaotalk'), true)).toBe('installed');
  });
  it('escapes the WebView before anything else — an install there can only fail', () => {
    expect(plan(env('android', 'kakaotalk'), false, true)).toBe('escape-android');
    expect(plan(env('ios', 'kakaotalk'))).toBe('escape-ios');
    expect(plan(env('other', 'facebook'))).toBe('escape-plain');
  });
  it('prefers the browser’s own prompt, and falls back to instructions per platform', () => {
    expect(plan(env('android'), false, true)).toBe('prompt');
    expect(plan(env('other'), false, true)).toBe('prompt');
    expect(plan(env('android'))).toBe('manual-android');
    expect(plan(env('ios'))).toBe('manual-ios'); // iOS never fires beforeinstallprompt, so there is only this
    expect(plan(env('other'))).toBe('desktop');
  });
});

describe('standalone detection', () => {
  it('trusts Safari’s navigator.standalone, which has no display-mode query', () => {
    expect(isStandalone({ navigator: { userAgent: UA.safariIOS, standalone: true } })).toBe(true);
    expect(isStandalone({ navigator: { userAgent: UA.safariIOS, standalone: false } })).toBe(false);
  });
  it('matches any of the installed display modes', () => {
    const mm = (yes: string) => (q: string) => ({ matches: q === yes });
    expect(isStandalone({ matchMedia: mm('(display-mode: standalone)') })).toBe(true);
    expect(isStandalone({ matchMedia: mm('(display-mode: minimal-ui)') })).toBe(true);
    expect(isStandalone({ matchMedia: mm('(display-mode: browser)') })).toBe(false);
  });
  it('survives a browser that throws on an unknown query', () => {
    expect(
      isStandalone({
        matchMedia: () => {
          throw new Error('nope');
        },
      }),
    ).toBe(false);
  });
});
