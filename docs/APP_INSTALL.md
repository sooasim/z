# 앱 아이콘 (홈 화면 설치) · 앱 자동 로그인

메인 페이지 맨 아래의 **"홈 화면에 앱 아이콘 만들기"** 가 하는 일과, 아이콘으로 실행했을 때
로그아웃할 때까지 로그인이 유지되는 구조를 정리합니다.

구현: `apps/web/lib/inapp.ts` · `apps/web/components/public/AppInstall.tsx` · `apps/web/app/app/`
· `apps/web/public/manifest.webmanifest` · `apps/web/lib/bff.ts` · `apps/api/src/modules/identity/service.ts`

## 왜 버튼 하나로 끝나지 않는가

우리 트래픽의 상당수는 카카오톡 링크로 들어오고, 카카오톡은 그 링크를 **자기 인앱 WebView** 에서 엽니다.
그 WebView 에는 "홈 화면에 추가" 메뉴가 없고 `beforeinstallprompt` 도 발생하지 않습니다. 즉 거기서 보여 주는
설치 버튼은 **무조건 실패**합니다. 그래서 설치 흐름은 먼저 페이지를 진짜 브라우저로 넘긴 뒤에 시작합니다.

```
카카오톡 인앱 ──"Chrome에서 열기"──▶ Chrome ──▶ /app?install=1 ──설치──▶ 홈 화면 아이콘
   (Android: intent://)                              │
   (iOS: kakaotalk://web/openExternal 시도)           └─ 아이콘 탭 ─▶ /app ─▶ 로그인 화면 또는 바로 입장
```

| 환경 | 화면 | 근거 |
|---|---|---|
| 인앱 WebView · Android | `intent://…;package=com.android.chrome;S.browser_fallback_url=…;end` 링크 | Chrome 공식 intent 문법. Chrome 이 없는 단말은 fallback URL 로 기본 브라우저가 열림 |
| 인앱 WebView · iOS | 카카오톡이면 `kakaotalk://web/openExternal` 시도 + ⋯ 메뉴 안내 + 주소 복사 | iOS 는 웹에서 브라우저를 지정하는 공개 API가 **없음**. 이 스킴은 카카오 비공식이라 버전에 따라 무동작 |
| 인앱 WebView · 그 외 | 새 탭으로 열기 | — |
| Chromium 계열 | `beforeinstallprompt` → 원탭 설치 | 브라우저 자체 설치 UI가 가장 확실 |
| iOS Safari | 공유 → "홈 화면에 추가" 3단계 안내 | iOS 에 설치 API 자체가 없음 |
| 일반 Android 브라우저 (프롬프트 없음) | ⋮ 메뉴 → "홈 화면에 추가" 3단계 안내 | — |
| 이미 설치됨 (standalone) | 설치 UI 대신 현재 로그인 상태 표시 | — |

판정은 `installPlan()` 한 함수에 모여 있고, 섹션 DOM 에 `data-install-plan` 으로 노출되므로 테스트가
"지금 어떤 UI 인지"를 그대로 확인할 수 있습니다.

### 두 가지 주의점

- **전환 링크는 반드시 사용자의 클릭이어야 합니다.** Chrome 은 사용자 제스처 없는 외부 앱 실행을 막습니다.
  그래서 전환 버튼은 `location.href` 를 대신 실행해 주는 버튼이 아니라 스킴이 `href` 에 들어 있는 `<a>` 입니다.
- **중계 대상은 항상 우리 origin 입니다.** 임의 URL 을 받아 넘겨 주는 중계 페이지는 피싱용 open redirect 가
  됩니다. `escapeTarget()` 이 origin 과 스킴을 검사하고, 어긋나면 URL 을 만들지 않고 던집니다.

### 배포 경로(basePath)

정적 데모는 `https://sooasim.github.io/z/` 처럼 **하위 경로**에서 돌아갑니다. 라우팅은 next/link 와 라우터가
알아서 `/z` 를 붙여 주지만, 전환 URL 은 우리가 손으로 만들어 **다른 브라우저에 넘기는** 절대 주소라 직접 붙여야
합니다. `basePathOf(SITE_URL)` 이 그 경로를 꺼내고 `escapeTarget()` 이 앞에 붙입니다(이미 붙어 있으면 그대로).
manifest 는 `public/` 의 JSON 이라 소스 패치 대상이 아니므로 `scripts/pages/build.mjs` 가 `id`·`start_url`·
`scope`·아이콘 경로를 basePath 기준으로 다시 씁니다 — 그렇게 하지 않으면 설치된 아이콘이 Pages 루트를 열고
아이콘은 404 가 됩니다.

### `beforeinstallprompt` 는 React 보다 먼저 온다

Chromium 은 이 이벤트를 **한 번만** 발생시키고 재생할 수 없습니다. 컴포넌트가 마운트된 뒤에 리스너를 붙이면
느린 단말에서 이벤트를 놓치고 원탭 설치가 조용히 수동 안내로 떨어집니다. 그래서 `INSTALL_PROMPT_SCRIPT` 가
`app/layout.tsx` 의 `<head>` 에서 이벤트를 `window.__jpInstall` 에 담아 두고, 컴포넌트가 그것을 집어 갑니다.

## 아이콘을 누르면 — `start_url` 과 앱 로그인

`manifest.webmanifest` 의 `start_url` 은 `/app` 입니다. `/app` 은 `AuthProvider` 가 마운트 때 돌리는 refresh
한 번을 기다린 뒤, 세션이 있으면 그대로 앱으로 들여보내고 없으면 `/login?app=1` (앱 배지 + "한 번 로그인하면
로그아웃할 때까지 자동으로 접속돼요") 로 보냅니다. `?install=1` 로 들어오면 — 인앱 브라우저에서 탈출해
도착한 경우 — 로그인으로 보내지 않고 설치 안내를 그대로 보여 줍니다.

`id` 는 예전 `start_url` 값인 `"/"` 로 **고정**했습니다. manifest 에 `id` 가 없으면 설치 시점의 `start_url` 이
암묵적 id 가 되므로, 그것을 적어 두지 않고 `start_url` 만 바꾸면 **이미 설치한 사람의 아이콘이 다른 앱으로
취급**됩니다.

## 로그아웃 전까지 자동 접속

| 무엇 | 어디 | 수명 |
|---|---|---|
| access token | **메모리만** (`lib/token.ts`) | 15분. 앱을 닫으면 사라짐 |
| refresh token | httpOnly 쿠키 `jp_rt`, `path=/api/auth` (`lib/bff.ts`) | 세션과 동일. 사용할 때마다 갱신 |

앱을 닫으면 access token 은 사라지지만 쿠키는 남습니다. 다시 실행하면 `/api/auth/refresh` 한 번으로 새
access token 을 받으므로 **로그인 화면이 나오지 않습니다.** JS 는 refresh token 을 볼 수 없으므로 XSS 로
빼낼 수 없고, httpOnly 서버 쿠키는 iOS ITP 의 7일 상한(script-writable storage) 대상도 아닙니다.

여기에 "로그아웃 전까지"를 실제로 성립시키기 위해 두 가지를 맞췄습니다.

1. **세션 만료가 미끄러집니다.** `refreshSession()` 이 회전할 때 `expires_at` 을 `now() + REFRESH_TOKEN_TTL_SEC`
   로 밀어 둡니다. 즉 30일은 *절대 수명* 이 아니라 *미사용 타임아웃* 입니다. 매일 쓰는 앱은 스스로 로그아웃되지
   않고, 방치된 세션은 마지막 사용 후 한 달 뒤 그대로 죽습니다. 회전·재사용 탐지·logout/logout-all 은 그대로입니다.
2. **쿠키 수명 = 세션 수명.** BFF 가 API 가 알려 준 `refreshExpiresAt` 을 쿠키 `maxAge` 로 씁니다. 쿠키가 세션보다
   오래 살면 "로그인된 것처럼 열렸다가 401" 이 되고, 짧으면 멀쩡한 세션을 버리게 됩니다.

로그아웃은 쿠키를 지우고 서버 세션을 revoke 하므로, 그 다음 실행은 다시 로그인 화면입니다.

## 테스트

자동 테스트 — 이 두 개는 CI 에서 돕니다.

```bash
cd apps/web && npx vitest run test/inapp.test.ts test/bff.test.ts   # 판정·intent·open redirect·쿠키 수명
cd apps/api && npx vitest run test/identity.test.ts                 # 세션 만료가 미끄러지는지
```

브라우저 검증은 로컬 스택(`scripts/dev-up.sh`)과, 실제로 배포되는 산출물(`node scripts/pages/build.mjs` →
`node scripts/pages/serve.mjs`, GitHub Pages 와 같은 하위 경로·트레일링 슬래시 동작)에 Playwright 로 붙여서 했습니다: 카카오톡 Android/iOS UA 에서
나오는 전환 링크 문자열, iOS 실패 안내, Chrome/Safari 수동 안내, standalone 판정, manifest 와 아이콘, 그리고
로그인 → 앱 재실행 → 오래된 세션 → 로그아웃 전 과정. **다만 Chrome 자신의 설치 판정 파이프라인(engagement
heuristic)은 자동화 프로필에서 돌지 않습니다** — 그래서 원탭 설치 경로는 Chrome 과 같은 모양의
`beforeinstallprompt` 를 주입해 검증했고, 실제 설치 프롬프트는 아래 실기기 체크리스트로 확인합니다.

### 실기기 체크리스트

HTTPS 공개 도메인에서만 의미가 있습니다 (카카오톡·설치 모두 보안 컨텍스트를 요구).

**Android + 카카오톡**
- [ ] 카카오톡 대화방에서 메인 페이지 링크 열기 → 맨 아래 섹션이 "카카오톡 안에서는 … 추가할 수 없어요" 안내
- [ ] `Chrome에서 열기` → Chrome 으로 전환, `/app?install=1` 도착 (path·query 유지)
- [ ] 그 화면에서 `앱 아이콘 만들기` → 설치 프롬프트 → 홈 화면에 아이콘 생성
- [ ] Chrome 미설치 단말: fallback URL 로 기본 브라우저가 열리는지
- [ ] 아이콘 탭 → 주소창 없이 실행되고 로그인 화면이 나오는지

**iPhone + 카카오톡**
- [ ] `Safari에서 열기` → 외부 브라우저 전환 여부 (실패해도 정상 경로)
- [ ] 전환되지 않으면 1.5초 뒤 ⋯ 메뉴 안내가 뜨는지, `주소 복사` 가 동작하는지
- [ ] 카카오톡 ⋯ → `다른 브라우저로 열기` → 공유 → `홈 화면에 추가` → 아이콘 생성
- [ ] 아이콘 탭 → 전체화면으로 실행되고 로그인 화면이 나오는지

**자동 로그인 (두 OS 공통)**
- [ ] 아이콘으로 실행해 한 번 로그인 → 앱 완전 종료 → 다시 실행 시 로그인 화면 없이 입장
- [ ] 기기 재부팅 후에도 동일
- [ ] 계정 → 로그아웃 → 다시 실행하면 로그인 화면

## 출처

첨부 패키지 `kakao_external_browser_kit_v1.0` 의 구조를 따랐고, 그 패키지가 밝힌 참고 자료는 다음입니다.

- Chrome for Developers — Android Intents with Chrome (`intent://`, `package=`, `S.browser_fallback_url`,
  사용자 제스처 제약): https://developer.chrome.com/docs/android/intents
- Apple Developer — Preparing your app to be the default web browser (iOS 14+ 기본 브라우저 설정):
  https://developer.apple.com/documentation/xcode/preparing-your-app-to-be-the-default-browser
- 카카오 DevTalk — 카카오는 외부 브라우저 오픈 기능을 **공식 제공하지 않으며**, 웹에서 쓰는 비공식 방법은
  정책에 따라 제한될 수 있음: https://devtalk.kakao.com/t/topic/145256
- 인앱 탈출 패턴 참고 구현: hyesungoh/open-external-browser · vzts/avoid-in-app.js ·
  luizcieslak/am-i-inapp-browser · m11to/inapp-escape

패키지의 코드를 그대로 가져오지 않았습니다. 판정·URL 생성 로직은 이 저장소 규칙에 맞춰 다시 썼고
(`lib/inapp.ts`), 패키지가 별도 중계 도메인에 올리도록 한 랜딩 페이지는 `/app` 라우트가 대신합니다.
