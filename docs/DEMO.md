# JETPOOL 정적 데모 (GitHub Pages) / Static demo

> 예상 주소 / Expected URL: **https://sooasim.github.io/z/**

## 한국어

### 무엇인가요?
`apps/web`의 **실제 화면(Next.js UI)** 을 서버 없이 GitHub Pages에서 끝까지 클릭해 볼 수 있게 만든 정적 데모입니다.

- 빌드할 때 `apps/web`을 `.pages-build/web`에 **복사**하고(원본은 절대 수정하지 않음) 정적 export(`output: 'export'`)로 빌드합니다.
- 페이지 맨 앞에서 `demo-backend.js`(`packages/demo`)가 먼저 실행되어 `window.fetch`를 가로챕니다.
  API 요청(`…/__demo_api/v1/*`)과 BFF 인증 경로(`/api/auth/*`)를 **녹화된 실제 API 응답**
  (`packages/demo/fixtures/api.json`)과 **브라우저 localStorage 상태**로 응답합니다.
- 핵심 흐름은 상태가 유지됩니다: 로그인/회원가입, 검색, 즐겨찾기, 견적 → 날짜 확보(hold) → 결제(MOCK) → 예약 확정,
  예약 취소(환불 미리보기), 메시지 보내기(데모 자동 응답), 홈 맞교환 제안·수락·안전수칙·서명·확정, 가이드 요청·제안·수락,
  투어 주문·결제·취소, 후기 작성, 알림 읽음 처리, 프로필/환경설정 변경. 그 밖의 쓰기 요청은 보낸 내용을 그대로 돌려주는 방식으로 흉내 냅니다.
- 화면 왼쪽 아래 **DEMO 리본**에서 페르소나(게스트·호스트·맞교환 회원·가이드·공급사·관리자)를 바로 바꾸거나 데모 데이터를 초기화할 수 있습니다.
  상태는 페르소나끼리 공유되므로, 게스트로 예약한 뒤 호스트로 바꾸면 호스트 예약 관리에 그 예약이 보입니다.

### 데모 계정
비밀번호는 모두 `Jetpool!2026dev` 입니다.

| 페르소나 | 이메일 |
| --- | --- |
| 게스트 | `guest@jetpool.dev` |
| 호스트(서울) / 호스트(제주) | `host.seoul@jetpool.dev` / `host.jeju@jetpool.dev` |
| 맞교환 회원(부산) | `exchange.busan@jetpool.dev` |
| 가이드 프렌드 / 전문 가이드 | `friend.guide@jetpool.dev` / `pro.guide@jetpool.dev` |
| 여행 공급사 | `supplier@jetpool.dev` |
| 관리자(MFA 완료 상태로 로그인) | `admin@jetpool.dev` |

이메일 코드 로그인, MFA 코드는 아무 6자리 숫자나 통과합니다. 소셜 로그인 버튼은 게스트로 로그인됩니다.

데모 계정의 **프로필 사진**은 오픈 라이선스(CC BY · CC BY-SA · CC0 · PDM) 실제 인물 사진입니다
(`data/media/people.json`, `scripts/legacy/fetch-people.mjs`). 사진 속 인물은 그 호스트·가이드·여행자 본인이 아니라
페르소나를 대신하는 예시이며, 출처는 `/credits`에 모두 표기됩니다.

### 한계
- **정적 사이트**입니다. 실제 백엔드·DB·PG가 없습니다. 데이터는 녹화 시점(`recordedAt`)의 스냅샷이며, 이후 변경은 **이 브라우저에만** 저장됩니다(다른 기기·사용자와 공유되지 않음).
- 결제는 **테스트(MOCK) 모드**입니다. 토스페이먼츠 SDK를 불러오지 않고 웹의 MOCK 경로(결제 성공 리다이렉트 → 서버 승인 흉내)를 그대로 탑니다.
- 상세 페이지는 미리 렌더링된 id만 열립니다(녹화된 id + 데모에서 새로 만들 예약·맞교환·주문 등을 위한 id 풀 30개씩).
  풀을 다 쓰면 새 항목은 목록에는 보이지만 상세 페이지는 404가 될 수 있습니다 → DEMO 리본의 **초기화**를 누르세요.
- 녹화된 날짜는 열어 보는 날에 맞춰 **지난 일수만큼 앞으로 옮겨집니다**(예정된 예약·출발일·최근 알림이 계속 '다가오는/최근' 상태로 보이도록).
- 실시간(SSE)은 이 브라우저에서 생긴 이벤트(메시지 자동 응답, 알림)만 전달합니다. 지도 타일 같은 외부 리소스는 인터넷에서 불러옵니다.
- 기록되지 않은 GET 요청은 가장 비슷한 녹화 응답(쿼리 무시) → 404 순서로 대체됩니다.
- 데모 런타임이 보완하는 부분(실제 API 응답에는 없음): 예약 목록 행의 숙소 이름·게스트 이름, 맞교환 홈 목록의 slug/사진,
  한국어 도시명 검색(예: `제주` → Jeju 숙소). 실제 API/웹에서 고칠 거리로 남겨 둡니다.

### GitHub Pages 켜기
`.github/workflows/pages.yml`이 정적 사이트를 빌드해 **`gh-pages` 브랜치**에 올립니다(브랜치 배포 방식).
1. `claude/eager-ride-bjce41` 브랜치에 push 하거나 **Actions → pages → Run workflow** 로 한 번 실행해 `gh-pages` 브랜치를 만듭니다.
2. 저장소 **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `gh-pages` / `(root)`** 를 선택하고 저장합니다.
   (공개 저장소는 `gh-pages` 브랜치가 생기면 GitHub가 자동으로 켜 주기도 합니다.)
3. **비공개(Private) 저장소**에서 Pages를 쓰려면 유료 GitHub 플랜(Pro/Team/Enterprise)이 필요합니다. 무료 플랜이면 저장소를 **공개(Public)** 로 바꿔야 합니다.
4. 1~2분 뒤 주소: **https://sooasim.github.io/z/** (basePath는 저장소 이름 `/z`).

### 픽스처 다시 녹화하기 / 로컬 빌드
```bash
# 1) 깨끗한 격리 DB(jetpool_demo)에 seed-dev(+ 있으면 seed-legacy) + 데모 활동(실제 API로 예약·MOCK 결제·메시지·맞교환·가이드·주문)을 만든 뒤 녹화
bash scripts/pages/record.sh            # 개발용 'jetpool' DB는 건드리지 않습니다 (PostgreSQL :5432 필요)
#    또는 이미 떠 있는 API를 그대로 녹화:  node scripts/pages/record-fixtures.mjs --api http://localhost:4000 --no-admin-mfa
#    (--no-admin-mfa 없이 실행하면 그 DB의 admin@ 계정에 TOTP가 등록됩니다 — 공유 개발 DB에서는 꼭 붙이세요)
# 2) 정적 빌드 → dist-pages/
NEXT_BASE_PATH=/z node scripts/pages/build.mjs
# 3) GitHub Pages처럼 /z/ 아래로 미리보기 → http://localhost:4173/z/
node scripts/pages/serve.mjs
# 4) (선택) Playwright 스모크 테스트
node scripts/pages/smoke.mjs
```
녹화 결과(`packages/demo/fixtures/api.json`)는 커밋합니다. CI는 이 파일만으로 빌드하므로 PostgreSQL이 필요 없습니다.

---

## English

### What is it?
A static, server-less build of the **real `apps/web` UI** that you can click through end to end on GitHub Pages.

- `scripts/pages/build.mjs` copies `apps/web` to `.pages-build/web` (the original is never modified) and runs a Next.js
  static export there (basePath, trailing slashes, `generateStaticParams` for every dynamic route from the recorded ids).
- `demo-backend.js` (`packages/demo`, bundled with esbuild) runs first in `<head>` and overrides `window.fetch`:
  calls to the demo API prefix (`…/__demo_api/v1/*`) and the BFF auth routes (`/api/auth/*`) are answered from
  **recorded real API responses** (`packages/demo/fixtures/api.json`) plus **browser-local state** (localStorage).
- Core flows are stateful: login/sign-up, search, favorites, quote → hold → MOCK payment → confirmed reservation, cancellation
  with refund preview, messages (with a demo auto-reply), home exchange request/counter/accept/safety-ack/sign/confirm,
  guide request/offer/accept, tour order/pay/cancel, reviews, notifications, profile/preferences. Any other write is echoed back.
- The **DEMO ribbon** (bottom-left) switches personas (guest/host/exchange/guide/supplier/admin) and resets the demo.
  State is shared between personas, so a booking made as the guest shows up for the host.

### Demo accounts
All use the password `Jetpool!2026dev`: `guest@`, `host.seoul@`, `host.jeju@`, `exchange.busan@`, `friend.guide@`,
`pro.guide@`, `supplier@`, `admin@jetpool.dev` (admin signs in already stepped-up to AAL2). Email OTP / MFA accept any 6 digits.

The **profile pictures** of those accounts are openly-licensed real portraits (CC BY · CC BY-SA · CC0 · PDM) published by
`scripts/legacy/fetch-people.mjs` into `data/media/people.json`. Each one stands in for a persona — it is not a photo of
that host, guide or traveller — and every one of them is credited on `/credits`.

### Limits
- **Static site** — no backend, database or payment gateway. Data is a snapshot taken at `recordedAt`; your changes live
  **only in this browser**.
- Payments run in **MOCK mode**: the Toss SDK is never loaded; the web's own MOCK path (success redirect → server-side
  confirmation, emulated) is used.
- Detail pages exist only for prerendered ids (recorded ids + a pool of 30 ids per kind for things you create). If the
  pool runs out, use **Reset** in the DEMO ribbon.
- Recorded dates are **shifted forward by the days elapsed since recording**, so upcoming stays/departures stay upcoming.
- Realtime only carries events created in this browser. Map tiles still load from the internet.
- Unrecorded GETs fall back to the closest recorded response (query-insensitive), then 404.
- Filled in by the demo runtime (absent from the real API responses): listing/guest names on reservation list rows,
  slug/photos on exchange-home rows, Korean city names in stay search (`제주` → Jeju). Worth fixing in the real API/web.

### Enabling GitHub Pages
`.github/workflows/pages.yml` builds the site and force-pushes it to the **`gh-pages` branch** (branch deployment).
1. Push to `claude/eager-ride-bjce41` or run **Actions → pages → Run workflow** once, which creates `gh-pages`.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `gh-pages` / `(root)`**, then save
   (for public repositories GitHub may switch this on by itself once `gh-pages` exists).
3. A **private repository** needs a paid GitHub plan for Pages; on the free plan make the repository **public**.
4. A minute or two later the site is at **https://sooasim.github.io/z/** (basePath = the repository name, `/z`).

### Re-recording fixtures and building locally
See the commands above: `bash scripts/pages/record.sh` (isolated `jetpool_demo` DB + private API on :4100, real flows with
MOCK payments), `node scripts/pages/build.mjs`, `node scripts/pages/serve.mjs`, `node scripts/pages/smoke.mjs`.
Commit `packages/demo/fixtures/api.json`; CI builds from it without PostgreSQL.
