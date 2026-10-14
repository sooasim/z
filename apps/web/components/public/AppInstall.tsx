'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Icon } from '@/components/ui';
import {
  APP_INSTALL_PATH,
  androidChromeIntent,
  basePathOf,
  detectEnv,
  escapeTarget,
  installPlan,
  isStandalone,
  kakaoOpenExternal,
  type AppEnv,
  type InstallPlan,
} from '@/lib/inapp';
import { SITE_URL } from '@/lib/env';

/**
 * Pre-React capture of `beforeinstallprompt`.
 *
 * Chromium fires it once, right after the page settles, and it cannot be replayed — a listener that only
 * attaches when <AppInstall> mounts misses it on a slow phone, and the one-tap install silently degrades to
 * "open the browser menu". So the event is stashed on `window` from an inline script in the document head,
 * and the component picks it up from there (plus the `jp:install*` events, for the normal case where it
 * arrives later). `preventDefault()` suppresses Chrome's own mini-infobar: the install lives in our own UI.
 */
export const INSTALL_PROMPT_SCRIPT =
  `(function(){var s={event:null,installed:false};window.__jpInstall=s;` +
  `window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();s.event=e;` +
  `window.dispatchEvent(new Event('jp:installprompt'))});` +
  `window.addEventListener('appinstalled',function(){s.installed=true;s.event=null;` +
  `window.dispatchEvent(new Event('jp:installed'))})})();`;

interface PromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
interface InstallSlot {
  event: PromptEvent | null;
  installed: boolean;
}

function slot(): InstallSlot {
  return (window as unknown as { __jpInstall?: InstallSlot }).__jpInstall ?? { event: null, installed: false };
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and permission; the in-app WebViews that need this button most
    // are exactly where it is missing, so fall back to the selection trick.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * "Make an app icon": installs this site as a home-screen app, from wherever the reader happens to be.
 *
 * `variant="page"` is the standalone landing used by /app?install=1 — the page an in-app browser escapes to,
 * where the only thing to do is finish the install. `variant="home"` is the section at the foot of the main page.
 */
export function AppInstall({ variant = 'home' }: { variant?: 'home' | 'page' }) {
  const { L } = useI18n();
  const { user, ready } = useAuth();
  const [env, setEnv] = useState<AppEnv | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState('');
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setEnv(detectEnv(navigator));
    setStandalone(isStandalone(window));
    setOrigin(window.location.origin);
    const sync = () => {
      const s = slot();
      setPromptReady(Boolean(s.event));
      if (s.installed) setDone(true);
    };
    sync();
    const installed = () => {
      setDone(true);
      setPromptReady(false);
    };
    window.addEventListener('jp:installprompt', sync);
    window.addEventListener('jp:installed', installed);
    return () => {
      window.removeEventListener('jp:installprompt', sync);
      window.removeEventListener('jp:installed', installed);
    };
  }, []);

  const target = useMemo(() => {
    if (!origin) return '';
    try {
      // The reader's own origin, with the deployment's subpath from SITE_URL: the static demo lives under /z,
      // and an escape URL without it would hand the external browser a 404.
      return escapeTarget(origin, APP_INSTALL_PATH, basePathOf(SITE_URL));
    } catch {
      return '';
    }
  }, [origin]);

  const install = useCallback(async () => {
    const e = slot().event;
    if (!e) return;
    try {
      await e.prompt();
      const { outcome } = await e.userChoice;
      // The event is single-use whatever the reader chose; a dismissal leaves the browser menu as the way in.
      (window as unknown as { __jpInstall: InstallSlot }).__jpInstall.event = null;
      setPromptReady(false);
      if (outcome === 'accepted') setDone(true);
      else setNotice(L('설치를 취소했어요. 브라우저 메뉴에서 "홈 화면에 추가"로도 만들 수 있어요.', 'Install cancelled. The browser menu’s “Add to Home screen” also works.'));
    } catch {
      setNotice(L('설치 창을 열 수 없었어요. 브라우저 메뉴에서 "홈 화면에 추가"를 선택해 주세요.', 'The install dialog did not open. Use “Add to Home screen” in the browser menu.'));
    }
  }, [L]);

  const copyLink = useCallback(async () => {
    const ok = await copy(target);
    setNotice(
      ok
        ? L('주소를 복사했어요. 브라우저 주소창에 붙여 넣어 주세요.', 'Link copied — paste it into your browser’s address bar.')
        : L('복사가 막혀 있어요. 아래 주소를 길게 눌러 복사해 주세요.', 'Copying is blocked here. Long-press the link below to copy it.'),
    );
  }, [L, target]);

  const plan: InstallPlan | null = env && target ? installPlan(env, { standalone: standalone || done, promptReady }) : null;
  const heading = L('홈 화면에 앱 아이콘 만들기', 'Add the app icon to your home screen');
  const lead = L(
    '아이콘을 누르면 앱 전용 로그인 화면이 열려요. 한 번 로그인하면 로그아웃할 때까지 자동으로 접속돼요.',
    'The icon opens the app login screen. Sign in once and you stay signed in until you log out.',
  );

  /** Numbered instructions for the browsers that have no install API — iOS has none at all. */
  const steps =
    plan === 'manual-ios'
      ? [
          L('화면 아래 공유 버튼을 누르세요.', 'Tap the share button at the bottom of the screen.'),
          L('"홈 화면에 추가"를 고르세요.', 'Choose “Add to Home Screen”.'),
          L('오른쪽 위 "추가"를 누르면 아이콘이 생겨요.', 'Tap “Add” at the top right and the icon appears.'),
        ]
      : plan === 'manual-android'
        ? [
            L('주소창 오른쪽 ⋮ 메뉴를 누르세요.', 'Tap the ⋮ menu to the right of the address bar.'),
            L('"앱 설치" 또는 "홈 화면에 추가"를 고르세요.', 'Choose “Install app” or “Add to Home screen”.'),
            L('"설치"를 누르면 아이콘이 생겨요.', 'Tap “Install” and the icon appears.'),
          ]
        : null;

  const inAppName =
    env?.inApp === 'kakaotalk'
      ? L('카카오톡', 'KakaoTalk')
      : env?.inApp === 'naver'
        ? L('네이버 앱', 'the Naver app')
        : env?.inApp === 'daum'
          ? L('다음 앱', 'the Daum app')
          : env?.inApp === 'line'
            ? 'LINE'
            : env?.inApp === 'instagram'
              ? 'Instagram'
              : env?.inApp === 'facebook'
                ? 'Facebook'
                : env?.inApp === 'band'
                  ? L('밴드', 'BAND')
                  : L('이 앱', 'this app');

  const Wrapper = variant === 'page' ? 'div' : 'section';

  return (
    <Wrapper
      id="app-install"
      className={variant === 'page' ? 'card stack' : 'section card'}
      aria-labelledby="app-install-h"
      style={variant === 'page' ? undefined : { background: 'var(--surface-2)', borderRadius: 'var(--r-xl)', padding: 'var(--sp-8)' }}
      data-install-plan={plan ?? 'pending'}
    >
      <div className="row" style={{ gap: 'var(--sp-4)', alignItems: 'center', marginBottom: 'var(--sp-4)' }}>
        {/* The icon that is about to land on the home screen — same file the manifest installs. */}
        <img src="/icons/icon.svg" alt="" width={56} height={56} style={{ borderRadius: 14, flex: '0 0 auto' }} />
        <div>
          <h2 id="app-install-h" style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>
            {heading}
          </h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {lead}
          </p>
        </div>
      </div>

      {plan === null ? null : done || plan === 'installed' ? (
        <div className="stack">
          <Alert tone="ok" icon="check">
            {done && !standalone
              ? L('홈 화면에 아이콘을 추가했어요. 이제 아이콘을 눌러 앱으로 접속해 보세요.', 'The icon is on your home screen — tap it to open the app.')
              : L('이미 앱으로 실행 중이에요.', 'You are already running the installed app.')}
          </Alert>
          {ready && user ? (
            <p className="small muted" style={{ margin: 0 }}>
              {L('자동 로그인이 켜져 있어요. 로그아웃할 때까지 다시 로그인하지 않아도 돼요.', 'You are signed in and will stay signed in until you log out.')}
            </p>
          ) : (
            <Link className="btn primary" href="/login?app=1">
              {L('앱으로 로그인하기', 'Sign in to the app')}
            </Link>
          )}
        </div>
      ) : plan === 'prompt' ? (
        <div className="stack">
          <Button variant="primary" icon="plus" onClick={install}>
            {L('앱 아이콘 만들기', 'Create the app icon')}
          </Button>
          <p className="small muted" style={{ margin: 0 }}>
            {L('설치 창이 뜨면 "설치"를 눌러 주세요.', 'Tap “Install” when the dialog appears.')}
          </p>
        </div>
      ) : plan === 'escape-android' || plan === 'escape-ios' || plan === 'escape-plain' ? (
        <div className="stack">
          <Alert tone="warn">
            {L(
              `${inAppName} 안에서 열린 화면에서는 홈 화면에 아이콘을 추가할 수 없어요. 먼저 브라우저로 옮긴 뒤 이어서 만들면 돼요.`,
              `A page opened inside ${inAppName} cannot add an icon to the home screen. Move to a browser first and carry on there.`,
            )}
          </Alert>
          {plan === 'escape-android' ? (
            // Chrome blocks an external-app launch without a user gesture, so this has to be the reader's own
            // click on a real link — not a redirect we run for them.
            <a className="btn primary block" href={androidChromeIntent(target)} data-testid="escape-android">
              <Icon name="external" size={18} /> {L('Chrome에서 열기', 'Open in Chrome')}
            </a>
          ) : plan === 'escape-ios' ? (
            <>
              {env?.inApp === 'kakaotalk' && (
                <a
                  className="btn primary block"
                  href={kakaoOpenExternal(target)}
                  data-testid="escape-ios"
                  onClick={() => {
                    // Kakao's scheme is undocumented and silently does nothing on some versions: if we are
                    // still here a moment later, point at the menu that always works.
                    window.setTimeout(() => setNotice(L('화면이 그대로면 카카오톡 오른쪽 아래 ⋯ 메뉴에서 "다른 브라우저로 열기"를 눌러 주세요.', 'If nothing happened, use “Open in another browser” in KakaoTalk’s ⋯ menu.')), 1500);
                  }}
                >
                  <Icon name="external" size={18} /> {L('Safari에서 열기', 'Open in Safari')}
                </a>
              )}
              <p className="small muted" style={{ margin: 0 }}>
                {L('아이폰은 웹에서 브라우저를 직접 지정할 수 없어요. 오른쪽 아래 ⋯ 메뉴의 "다른 브라우저로 열기"가 가장 확실해요.', 'On iPhone a web page cannot pick the browser. “Open in another browser” in the ⋯ menu is the sure way.')}
              </p>
            </>
          ) : (
            <a className="btn primary block" href={target} target="_blank" rel="noreferrer" data-testid="escape-plain">
              <Icon name="external" size={18} /> {L('브라우저에서 열기', 'Open in a browser')}
            </a>
          )}
          <Button icon="doc" onClick={copyLink}>
            {L('주소 복사', 'Copy the link')}
          </Button>
          <p className="small muted" style={{ margin: 0, wordBreak: 'break-all' }}>{target}</p>
        </div>
      ) : steps ? (
        <ol className="stack" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {steps.map((t) => (
            <li key={t} className="small">
              {t}
            </li>
          ))}
        </ol>
      ) : (
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            {L('앱 아이콘은 휴대폰에서 만들 수 있어요. 아래 주소를 휴대폰 브라우저에서 열어 주세요.', 'The app icon is made on a phone — open this link in your phone’s browser.')}
          </p>
          <Button icon="doc" onClick={copyLink}>
            {L('주소 복사', 'Copy the link')}
          </Button>
          <p className="small muted" style={{ margin: 0, wordBreak: 'break-all' }}>{target}</p>
        </div>
      )}

      {notice && (
        <p className="small" style={{ marginBottom: 0 }} role="status">
          {notice}
        </p>
      )}
    </Wrapper>
  );
}
