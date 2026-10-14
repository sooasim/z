/**
 * "Add the app icon to the home screen", and the in-app-browser escape it needs first.
 *
 * Most of our Korean traffic arrives through a KakaoTalk link, and KakaoTalk opens it in its own WebView.
 * That WebView has no "add to home screen" menu and never fires `beforeinstallprompt`, so an install button
 * shown there can only fail — the page has to be handed to a real browser first. Per platform:
 *
 *   Android  an `intent://` URI naming `package=com.android.chrome` (the documented Chrome mechanism) with
 *            `S.browser_fallback_url` so a device without Chrome still lands on the page in its own browser.
 *   iOS      no public API can pick a browser from a web page. KakaoTalk's `kakaotalk://web/openExternal`
 *            is undocumented and may stop working with any KakaoTalk release, so it is attempted and we fall
 *            back to telling the reader about the ⋯ menu, plus a copy-the-link button.
 *
 * Both escape URLs must be navigated to inside the click that the reader made: Chrome blocks an external-app
 * launch without a user gesture. Hence the UI renders them as plain `<a href>`, which is also what makes them
 * assertable in a test.
 *
 * Adapted from kakao_external_browser_kit v1.0; `docs/APP_INSTALL.md` records the upstream sources and the
 * parts of this that are, by nature, best-effort.
 */

export type AppOS = 'android' | 'ios' | 'other';

/** The in-app WebViews common in Korean traffic. `webview` is an unidentified Android WebView. */
export type InAppBrowser = 'kakaotalk' | 'naver' | 'daum' | 'line' | 'instagram' | 'facebook' | 'band' | 'webview' | null;

export interface AppEnv {
  os: AppOS;
  /** null when this is a normal browser (Chrome, Safari, Samsung Internet, a desktop browser …). */
  inApp: InAppBrowser;
}

/** The parts of `navigator` this module reads — passed in so the logic is testable without a DOM. */
export interface NavLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** Safari's non-standard flag: true in an iOS home-screen web app. */
  standalone?: boolean;
}

/** The home-screen icon opens this: the app entry, which shows the login screen or signs the reader straight in. */
export const APP_LAUNCH_PATH = '/app';
/** Where an escaped in-app browser lands: the same app entry, showing the install guide. */
export const APP_INSTALL_PATH = '/app?install=1';

export function detectOS(nav: NavLike): AppOS {
  const ua = nav.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  // iPadOS asks for desktop sites by default, so its UA says "Macintosh". A Mac with a touch screen is the
  // only false positive and there is none; `maxTouchPoints` is how Apple's own docs suggest telling them apart.
  if (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1) return 'ios';
  return 'other';
}

export function detectInApp(userAgent: string): InAppBrowser {
  const ua = userAgent || '';
  if (/kakaotalk/i.test(ua)) return 'kakaotalk';
  if (/naver\(inapp/i.test(ua)) return 'naver';
  if (/daumapps|daum\//i.test(ua)) return 'daum';
  if (/\bline\//i.test(ua)) return 'line';
  if (/instagram/i.test(ua)) return 'instagram';
  if (/fban|fbav|fb_iab/i.test(ua)) return 'facebook';
  if (/\bband\//i.test(ua)) return 'band';
  // Android marks every WebView with `; wv)`. Chrome Custom Tabs do not carry it, so this does not catch them.
  if (/;\s*wv\)/i.test(ua)) return 'webview';
  return null;
}

export function detectEnv(nav: NavLike): AppEnv {
  return { os: detectOS(nav), inApp: detectInApp(nav.userAgent) };
}

/**
 * The target handed to the external browser. Always built from this page's own origin: a relay that forwards
 * an arbitrary URL is an open redirect, and a phishing link shared in KakaoTalk is exactly the abuse the kit
 * warns about. Throws rather than returning a URL it cannot vouch for.
 */
export function escapeTarget(origin: string, path: string = APP_INSTALL_PATH): string {
  const base = new URL(origin);
  const url = new URL(path, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`unsupported scheme: ${url.protocol}`);
  if (url.origin !== base.origin) throw new Error(`refusing to hand off another origin: ${url.origin}`);
  return url.toString();
}

/**
 * Chrome's documented intent URI. `#Intent` is the separator inside the URI, so a fragment in the target has
 * to survive as `%23`; the whole target is repeated, encoded, as the fallback for a device without Chrome.
 */
export function androidChromeIntent(target: string): string {
  const u = new URL(target);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported scheme: ${u.protocol}`);
  const scheme = u.protocol.replace(':', '');
  const fragment = u.hash ? `%23${encodeURIComponent(u.hash.slice(1))}` : '';
  const destination = `${u.host}${u.pathname}${u.search}${fragment}`;
  return (
    `intent://${destination}#Intent;scheme=${scheme};action=android.intent.action.VIEW;` +
    `package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target)};end`
  );
}

/** KakaoTalk's undocumented external-browser scheme. Unsupported by Kakao; may be a no-op on any version. */
export function kakaoOpenExternal(target: string): string {
  return `kakaotalk://web/openExternal?url=${encodeURIComponent(target)}`;
}

/**
 * Which of the install UIs applies.
 *
 *   installed       already running from the home screen — nothing to install
 *   prompt          Chromium handed us a `beforeinstallprompt`: one tap installs
 *   escape-android  in-app WebView on Android → open in Chrome, then install there
 *   escape-ios      in-app WebView on iOS → try KakaoTalk's scheme / the ⋯ menu, then install there
 *   escape-plain    in-app WebView on neither → just open the page in a normal browser
 *   manual-android  a normal Android browser that gave us no prompt → its own menu does it
 *   manual-ios      Safari and friends have no install API at all → the share sheet does it
 *   desktop         no phone, no prompt → the icon belongs on a phone, so hand over the link
 */
export type InstallPlan =
  | 'installed'
  | 'prompt'
  | 'escape-android'
  | 'escape-ios'
  | 'escape-plain'
  | 'manual-android'
  | 'manual-ios'
  | 'desktop';

export function installPlan(env: AppEnv, state: { standalone: boolean; promptReady: boolean }): InstallPlan {
  if (state.standalone) return 'installed';
  if (env.inApp) return env.os === 'android' ? 'escape-android' : env.os === 'ios' ? 'escape-ios' : 'escape-plain';
  // A real prompt beats any hand-written instructions, so it wins wherever Chromium offers one.
  if (state.promptReady) return 'prompt';
  if (env.os === 'ios') return 'manual-ios';
  if (env.os === 'android') return 'manual-android';
  return 'desktop';
}

/** True when the page is running as an installed app rather than in a browser tab. */
export function isStandalone(win: { matchMedia?: (q: string) => { matches: boolean }; navigator?: NavLike } = {}): boolean {
  // iOS has never implemented the display-mode media query for home-screen web apps; `navigator.standalone` is it.
  if (win.navigator?.standalone) return true;
  if (typeof win.matchMedia !== 'function') return false;
  return ['(display-mode: standalone)', '(display-mode: fullscreen)', '(display-mode: minimal-ui)'].some((q) => {
    try {
      return win.matchMedia!(q).matches;
    } catch {
      return false;
    }
  });
}
