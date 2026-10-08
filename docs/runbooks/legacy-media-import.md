# Runbook — 레거시 미디어·콘텐츠 이전 / Legacy media & content import (MIG-01)

WONT Travel Club(`https://www.wontc.co.kr`, Sixshop 호스팅)의 **모든 공개 이미지·동영상·페이지 콘텐츠**를 JETPOOL로
옮기는 절차입니다. 도구: `packages/legacy-import` (`@jetpool/legacy-import`), DEV 시드: `packages/db/seed-legacy.mjs`.
관련 문서: 백서 마이그레이션 절차(“Media import — broken media 0”), `dd/JETPOOL_MASTER_BUILD_SPEC.yaml` MIG-01,
`docs/runbooks/legacy-cutover.md` (컷오버 당일 절차).

Moves **every public image, video and page** of WONT Travel Club (`https://www.wontc.co.kr`, hosted on Sixshop) into
JETPOOL. Tooling: `packages/legacy-import`; DEV seed: `packages/db/seed-legacy.mjs`. See the whitepaper migration
procedure (“Media import — broken media 0”), MIG-01 in `dd/JETPOOL_MASTER_BUILD_SPEC.yaml`, and
`docs/runbooks/legacy-cutover.md` for the cutover window itself.

```
crawl ─▶ download ─▶ optimise ─▶ publish ─▶ import ─▶ report
 │          │            │           │          │          └ out/report.md|json  (coverage, failures, duplicates, bytes)
 │          │            │           │          └ out/import/{plan.json,content.csv,media.csv,redirects.csv}
 │          │            │           └ apps/web/public/legacy/<sha12>/… + out/manifest.json
 │          │            └ out/build/<sha12>/<name>-{480,960,1600,2400}.webp, blur placeholder, video poster
 │          └ out/staging/<aa>/<sha256>.<ext>  (verified, deduplicated originals)
 └ out/inventory.json, out/urls.csv, out/snapshots/<sha256>.html
```

---

## 1. 소유자 승인 / Owner authorisation

**KO.** 이 이전은 WONT Travel Club **사업자(사이트 소유자)의 요청과 승인**에 따라 소유자 본인의 공개 콘텐츠를 옮기는
작업입니다. 실행 전에 다음을 기록하세요(티켓 또는 `reports/` 메모): 승인자 이름·직책, 승인 일시, 대상 도메인
(`www.wontc.co.kr`, Sixshop CDN), 범위(공개 페이지·이미지·영상), 실행자.

- 공개 콘텐츠만 수집합니다. **회원정보·비밀번호·주문/결제 정보는 절대 스크래핑하지 않습니다** — 이것은 Sixshop 공식
  Export와 `apps/api/scripts/migrate-legacy.ts import-members`(공식 파일만) 경로로만 다룹니다.
- 로그인·장바구니·주문·마이페이지·검색 URL은 기본적으로 제외되며, `robots.txt`를 항상 따릅니다.
- 크롤러는 `JETPOOL-Migration/1.0 (+owner-authorised)` User-Agent로 자신을 밝히고, 동시 2요청·호스트당 500 ms 간격,
  재시도 백오프로 사이트에 부담을 주지 않습니다.
- YouTube/Vimeo 임베드는 **링크·썸네일 URL만 기록**하고 영상 스트림은 내려받지 않습니다(제3자 플랫폼 약관).
- 회원 얼굴 등 개인정보가 담긴 사진(후기 사진 등)은 게시 전에 소유자가 게시 동의 여부를 확인합니다(5단계).

**EN.** This migration is performed **at the request and with the authorisation of the WONT Travel Club business
owner** and copies the owner's own public content. Before running, record (ticket or a note under `reports/`):
approver name/role, date/time, domains (`www.wontc.co.kr`, Sixshop CDN), scope (public pages, images, video), operator.

- Public content only. **Never scrape member data, passwords, orders or payments** — those come exclusively from the
  official Sixshop export via `apps/api/scripts/migrate-legacy.ts import-members` (official files only).
- Login / cart / order / my-page / search URLs are excluded by default and `robots.txt` is always obeyed.
- The crawler identifies itself as `JETPOOL-Migration/1.0 (+owner-authorised)` and is polite: 2 concurrent requests,
  ≥ 500 ms between requests per host (more if `Crawl-delay` says so), retries with exponential backoff.
- YouTube/Vimeo embeds are **recorded (id, watch URL, thumbnail URL) but never downloaded** (third-party terms).
- Photos showing identifiable people (member reviews etc.) need the owner's confirmation of consent before publishing
  (step 5).

---

## 2. 네트워크 허용 / Allow the hosts in the environment network policy

**KO.** 샌드박스·CI·사내망에는 외부 접속 허용 목록(egress allowlist)이 있는 경우가 많습니다. 차단되어 있으면 크롤러가
즉시 다음과 같이 중단합니다:
`cannot crawl https://www.wontc.co.kr: robots.txt is unreachable (PROXY_403 …); the egress proxy / network policy denies www.wontc.co.kr`.
이때는 **우회하지 말고**(다른 프록시·외부 fetch 서비스·CI 트리거 금지) 허용 목록에 호스트를 추가합니다.

- **Claude Code 클라우드 환경**: 세션 제목 표시줄의 클라우드 환경 메뉴 → *Edit* → *Network access* 에서
  *Allowed domains*에 아래 호스트를 추가합니다(“Allow package managers”는 체크된 채로 둡니다). 화면에 Allowed domains가
  없으면 *Custom* 수준에서 추가합니다. 안내: <https://code.claude.com/docs/en/cloud-environments#network-access>
- **사내 프록시/방화벽/CI**: 아래 호스트를 HTTPS(443) 아웃바운드로 허용합니다. 도구는 `HTTPS_PROXY`/`HTTP_PROXY`/
  `NO_PROXY`를 따르며, TLS 가로채기 프록시라면 `NODE_EXTRA_CA_CERTS=<ca-bundle.pem>`을 지정합니다.

**EN.** Sandboxes, CI runners and corporate networks often have an egress allowlist. When the site is blocked, the
crawler stops immediately with the error above (`PROXY_403` = the proxy refused the CONNECT tunnel). **Do not route
around it** (no alternative proxies, third-party fetch services or CI tricks) — add the hosts to the allowlist:

- **Claude Code cloud environment**: cloud-environment menu in the session title bar → *Edit* → *Network access* →
  add the hosts under *Allowed domains* (keep “Allow package managers” ticked; older apps show the list under the
  *Custom* level). Docs: <https://code.claude.com/docs/en/cloud-environments#network-access>
- **Corporate proxy / firewall / CI**: allow outbound HTTPS (443) to the hosts below. The tool honours
  `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`; for a TLS-intercepting proxy set `NODE_EXTRA_CA_CERTS=<ca-bundle.pem>`.

| Host | Why |
|---|---|
| `www.wontc.co.kr`, `wontc.co.kr` | pages, robots.txt, sitemap.xml, site-hosted images |
| `*.sixshop.com` (e.g. `contents.sixshop.com`, `thumb.sixshop.com`, `static.sixshop.com`) | Sixshop image/video CDN |
| `*.sixshop.kr` (e.g. `thumb.sixshop.kr` resize proxy), `*.sixshop.io` | other Sixshop asset domains |
| `static-sixshop2.s3.ap-northeast-2.amazonaws.com` | Sixshop theme files (S3) — observed on www.wontc.co.kr |
| anything listed in `out/report.md` → “Hosts denied by the egress proxy” / “Hosts not in the asset allowlist” | discovered at run time |

확인 / check: `curl -sSI https://www.wontc.co.kr/robots.txt` → `HTTP/2 200` (또는 404) 이면 준비 완료 / ready.

---

## 3. 실행 / Run

**KO.** 저장소 루트에서 실행합니다. 상대 경로는 명령을 실행한 디렉터리 기준입니다. `ffmpeg`/`ffprobe`가 있으면 영상
길이 측정과 포스터 추출을 하고, 없으면 그 단계만 건너뜁니다. 중단되면 같은 명령에 `--resume`을 붙여 이어서 실행합니다
(완료된 페이지·파일은 다시 받지 않음).

**EN.** Run from the repository root (relative paths resolve against the directory you run from). With
`ffmpeg`/`ffprobe` installed, video duration and poster frames are extracted; without them those steps are skipped.
If a run is interrupted, re-run the same command with `--resume` (finished pages/files are not fetched again).

```bash
pnpm install

# full pipeline (crawl → download → optimise → publish → import → report)
pnpm --filter @jetpool/legacy-import run migrate -- \
  --start https://www.wontc.co.kr/ --start https://www.wontc.co.kr/about_jetpool \
  --max-pages 500 --out packages/legacy-import/out --public-dir apps/web/public/legacy

# continue after an interruption / after allowing more hosts (only missing work is done)
pnpm --filter @jetpool/legacy-import run migrate -- --resume

# a newly discovered CDN host (from report.md) — confirm it belongs to the site first
pnpm --filter @jetpool/legacy-import run migrate -- --resume --asset-host 'img.example-cdn.com'

# single steps: crawl | extract | download | optimise | publish | import | report | all
pnpm --filter @jetpool/legacy-import run migrate -- report
pnpm --filter @jetpool/legacy-import run migrate -- --help
```

| Option | Default | Notes |
|---|---|---|
| `--start <url>` (repeat) | `/` and `/about_jetpool` | BFS start points; `sitemap.xml` and robots `Sitemap:` entries are always added |
| `--max-pages` / `--max-depth` | 500 / 10 | further URLs are listed as `MAX_PAGES` / `MAX_DEPTH` in the report |
| `--asset-host` (repeat) / `--asset-hosts a,b` | `www.wontc.co.kr, wontc.co.kr, *.sixshop.com, *.sixshop.kr, *.sixshop.io` | media outside the allowlist are *reported*, never fetched |
| `--cdn-originals both\|prefer\|off` | `both` | fetches un-resized originals (`?w=`… stripped, Sixshop `/thumbnails/…_750.jpg` → `/uploadedFiles/….jpg`) **and** the referenced URL; the larger wins, the other is kept as an alternate |
| `--concurrency` / `--delay` | 2 / 500 ms | do not raise for the live site |
| `--max-image-mb` / `--max-video-mb` | 30 / 300 | larger files fail with `TOO_LARGE` |
| `--widths` | `480,960,1600,2400` | webp renditions, never upscaled (a native-width rendition is added for smaller originals) |
| `--allow-partial` | off | exit 0 even when coverage < 100 % |
| `--retry-failed` | off | with `--resume`, also retry permanent failures (404, robots, …) |
| `--ignore-robots-for-assets` | off | media hosts only, when the owner confirms their own CDN blocks bots; page crawling always obeys robots |
| `--extra-media <file>` | — | HAR / JSON / CSV of media seen in a real browser (JavaScript-loaded slides); merged into the inventory and remembered for later `--resume` runs |
| `--include-template-pages` | off | also migrate Sixshop's default “사용 설명서” editor-manual pages (`/guide`, `/notice_guide`, `/qna_guide`, `/review_guide`), whose images are Sixshop sample content |

Exit codes: `0` ok · `1` error (e.g. unreachable site) · `2` usage · `3` media coverage < 100 % (without `--allow-partial`).

로컬 연습(인터넷 불필요) / offline rehearsal: `pnpm --filter @jetpool/legacy-import run fixture-site` 가 Sixshop 형태의
가짜 사이트+CDN을 띄우고 실행 명령을 출력합니다 (prints a ready-to-run command against a local fake Sixshop site + CDN).
테스트 / tests: `pnpm --filter @jetpool/legacy-import test` (fixture site; the DB test uses a scratch database and is
skipped without PostgreSQL).

> **공유 디렉터리 주의 / Shared directory warning.** 이 저장소의 다른 미디어 파이프라인(`scripts/legacy/*.mjs` →
> `data/media/optimized.json`, 레이아웃 `<sha12>/original.<ext>`, `<w>.webp`)도 `apps/web/public/legacy/`에 쓰며, 자신이
> 만들지 않은 항목을 **삭제(prune)** 합니다. 두 도구를 같은 디렉터리에 함께 쓰지 마세요. 한 파이프라인이 소유를 정할 때까지
> 이 도구는 별도 디렉터리에 게시합니다 (publish step and report warn when they detect that layout):
> `--public-dir apps/web/public/legacy-import --url-prefix /legacy-import` (then `seed-legacy` resolves `/legacy-import/...`
> under `--public-dir apps/web/public` unchanged). Another pipeline in this repo (`scripts/legacy/*.mjs`) also writes
> `apps/web/public/legacy/` and prunes every entry it did not create; never run both against the same directory.

---

## 4. 결과 검토 / Review the report

**KO.** `packages/legacy-import/out/report.md`를 엽니다. 목표는 **Media coverage 100 %**(페이지에서 참조된 고유 미디어
URL이 모두 다운로드됨, 백서 기준 “broken media 0”)입니다. 100 % 미만이면 명령이 종료 코드 3으로 끝납니다.

**EN.** Open `packages/legacy-import/out/report.md`. The target is **media coverage 100 %** (every unique media URL
referenced on a page was downloaded — the whitepaper's “broken media 0”). Below 100 % the command exits with 3.

| Reason | 의미 / Meaning | 조치 / Action |
|---|---|---|
| `HTTP_404`, `HTTP_410` | 레거시 사이트에서 이미 깨진 이미지 / already broken on the legacy site | 소유자에게 원본 파일 요청 → 받으면 수동 추가, 아니면 `--allow-partial`로 수용하고 보고서에 사유 기록 / ask the owner for the original or accept with `--allow-partial` and note it |
| `NOT_MEDIA text/html`, `UNEXPECTED_CONTENT_TYPE`, `MAGIC_UNSUPPORTED` | 이미지 URL이 HTML(소프트 404) 등을 반환 / the URL returns HTML (soft 404) or an unknown format | 위와 동일 / as above |
| `HOST_NOT_ALLOWED` | 허용 목록 밖 호스트 / host not in the asset allowlist | 사이트 소유 자산인지 확인 후 `--asset-host` + 2단계 네트워크 허용 → `--resume` / confirm ownership, allow it, `--resume` |
| `PROXY_403`, `ROBOTS_UNREACHABLE PROXY_403` | 네트워크 정책 차단 / blocked by the egress policy | 2단계 → `--resume` (자동 재시도 대상) / step 2, then `--resume` (retried automatically) |
| `ROBOTS_DISALLOWED` | robots.txt 금지 / disallowed by robots.txt | 페이지는 그대로 둠. CDN이면 소유자 확인 후 `--ignore-robots-for-assets --resume --retry-failed` / pages: leave; own CDN: owner-confirmed override |
| `TOO_LARGE` | 크기 제한 초과 / over the size cap | 원본 확인 후 `--max-video-mb`/`--max-image-mb` 상향 + `--resume --retry-failed` |
| `TIMEOUT`, `ECONNRESET`, `HTTP_5xx`, `HTTP_429` | 일시 오류 / transient | `--resume` |

함께 확인 / also check: **Pages** 표(페이지별 참조·다운로드·실패 수), **Skipped URLs**(robots/제외 패턴),
**Sixshop template pages**(기본 사용 설명서, 기본 제외), **Duplicates**(같은 바이트, 하나로 저장), **Other iframes**(지도·SNS
위젯 등은 수동 판단), **Embedded videos**, **Linked documents**(PDF/HWP 등은 수동 이전).

**JavaScript로만 불러오는 이미지 / images loaded only by JavaScript.** 정적 크롤은 HTML·CSS·인라인 스크립트에 있는 URL만
봅니다. 실제 사이트 캡처로 검증한 결과, 브라우저가 불러온 소유자 미디어 311개 중 290개를 정적 추출로 찾았고, 나머지는
JS 슬라이드 이미지 2개(각 2개 URL), 로딩 스피너 1개, Sixshop 템플릿 샘플 이미지였습니다. 브라우저에서 보이는데 보고서에
없는 이미지가 있으면 해당 페이지에서 DevTools → Network → *Save all as HAR*로 저장한 뒤 다음을 실행합니다
(A capture of the real site showed static extraction finds 290 of the 311 owner media files a browser loads; the rest
were 2 JS-loaded slides, a loading spinner and Sixshop's template sample images. For anything visible in a browser
but missing from the report, save a HAR in DevTools and run):

```bash
pnpm --filter @jetpool/legacy-import run migrate -- --resume --extra-media ~/wontc-session.har
```

---

## 5. 플랫폼 반영 / Import into the platform

### 5a. DEV / 로컬 — `seed-legacy.mjs`

**KO.** `out/manifest.json`이 있을 때만 동작하는 DEV 시드입니다(없으면 아무것도 하지 않고 0으로 종료,
`NODE_ENV=production`이면 거부). 결정적 ID·멱등(같은 manifest로 다시 실행하면 변경 없음)·단일 트랜잭션이며, 기존
데이터를 지우거나 편집된 내용을 덮어쓰지 않습니다.

**EN.** DEV seed that only acts when `out/manifest.json` exists (otherwise exits 0; refuses `NODE_ENV=production`).
Deterministic ids, idempotent (same manifest ⇒ no changes), one transaction, never deletes or overwrites edited data.

```bash
pnpm db:migrate && pnpm db:seed                    # demo data first (seed-dev.mjs)
node packages/db/seed-legacy.mjs                   # or: pnpm --filter @jetpool/legacy-import run seed:legacy
node packages/db/seed-legacy.mjs --dry-run         # counts only
node packages/db/seed-legacy.mjs --publish         # insert new legacy entries as PUBLISHED (DEV demos only)
```

What it writes:
- `media_assets` (purpose `CMS`, visibility `PUBLIC`, `public_url` `/legacy/<sha12>/<name>-1600.webp` — the web
  rendition; `storage_key`, `sha256`, `byte_size`, `mime_type` describe the original) + `migration_id_map`
  (`media`, `media_url` for every source URL and public path).
- `cms_entries`, one per legacy page, **`DRAFT`**: slug `legacy-<path>`, `body_md` with `/legacy/...` images,
  captions, video/poster links and YouTube links; `seo` from `<title>`/meta/og; `hero_media_id`; `data.gallery`,
  `data.videos`, `data.embeds`, `data.legacy` (source URL, snapshot sha256). Types: `/` and route-mapped pages → `PAGE`,
  `/board/…` → `STORY`, others → `LEGACY_CONTENT`. Rows are refreshed by a newer manifest only while their body is
  unchanged since the last seed.
- `cms_external_refs` (`LEGACY_WONT`, `page:<path>`, `external_url`).
- `seo_redirects` legacy path → new path, **`approved = false`**, `source = 'LEGACY_WONT'` (existing mappings untouched):
  `/about_jetpool` → `/jetpool-charter`, `/localLife…` → `/exchange`, `/tour…` → `/travel`, `/guide…` → `/guide-friends`,
  `/board/…` → `/stories/<slug>`, URL aliases (301s on the old site) → same target.
- Demo listings where the legacy context matches (seed-owned demo rows only): Local Life / 한달살기 photos →
  exchange-enabled demo homes (`property_media`, shown first); tour photos → WONT demo travel products (`media_ids`);
  guide photos → demo guides without an avatar; charter / about_jetpool → the `jetpool-charter` PAGE (cover, hero,
  `data.legacyGallery`); city photos → destination covers. Only generated placeholder covers (`/art/…`,
  `/placeholder/…`) are replaced; the previous value is kept in `data.legacyCover.previous`.

### 5b. Staging / Production — API migration CLI (감사 기록 / audited path)

**KO.** 운영 경로는 MIG-01 공식 CLI입니다. 기본은 DRY_RUN이며 `--apply`로 실제 반영합니다. 모든 배치는
`migration_batches`·`migration_audit`·`migration_id_map`에 기록됩니다. **순서: content → media → redirects**
(redirects.csv가 content 단계의 기본 후보 `/stories/<slug>`를 큐레이션된 경로로 바로잡습니다).

**EN.** The production path is the MIG-01 CLI (DRY_RUN by default, `--apply` writes; every batch is recorded in
`migration_batches`/`migration_audit`/`migration_id_map`). **Order: content → media → redirects** (redirects.csv
corrects the content importer's default `/stories/<slug>` candidates to the curated routes).

```bash
cd apps/api
OUT=../../packages/legacy-import/out/import
npx tsx scripts/migrate-legacy.ts import-content   --source WONT --file $OUT/content.csv                 # DRY_RUN
npx tsx scripts/migrate-legacy.ts import-media     --source WONT --file $OUT/media.csv --media-dir ../../apps/web/public/legacy
npx tsx scripts/migrate-legacy.ts import-redirects --source WONT --file $OUT/redirects.csv
# then the same three commands with --apply (media: add --stage-dir <dir> and/or --cdn-base-url https://<cdn> when
# the files go to object storage instead of being served from the web app at /legacy/...)
npx tsx scripts/migrate-legacy.ts reconcile --source WONT --inventory ../../packages/legacy-import/out/urls.csv --out ../../reports/reconcile-wont
```

`reconcile` must show `content|media|redirects.batch_balanced_no_errors = PASS` and `media.no_broken_references = PASS`.
(`members.*` checks belong to the official member export, not to this runbook.) Files referenced as `/legacy/...`
must be deployed with the web app (`apps/web/public/legacy/`) or served by the CDN under the same path.

---

## 6. 검토·승인 / Review & approval

**KO.**
1. **CMS 초안 검토**: 관리자 → *콘텐츠 · SEO* (`/admin/cms`) → *레거시 콘텐츠* / *페이지·브랜드* / *스토리* 탭에서
   `legacy-…` 초안을 엽니다. 확인: 제목·요약, 이미지 표시(깨진 이미지 없음), 캡션, 개인정보가 담긴 사진, 오래된 가격·
   연락처·이벤트 문구. 수정 후 *게시* (`POST /v1/admin/cms/entries/:id/publish`, 상태 전이는 FSM과 감사 로그에 기록).
   게시하지 않을 페이지는 *보관(archive)* 합니다.
2. **301 리다이렉트 승인**: *리다이렉트* 탭에서 `LEGACY_WONT` 출처의 미승인 항목을 검토하고, 업무 책임자 승인 후 ADMIN
   (AAL2)이 승인합니다 (`POST /v1/admin/seo/redirects/approve {"paths":[…]}`). 대상 경로가 실제로 열리는지 확인하세요
   (예: `/stories/legacy-…`는 해당 초안이 게시되어야 열립니다).
3. **보고서 보관**: `out/report.md`, `out/manifest.json`, `out/import/*`를 변경 요청(PR)에 첨부합니다.

**EN.**
1. **Review CMS drafts**: Admin → *Content & SEO* (`/admin/cms`) → *Legacy content* / *Pages & brand* / *Stories*;
   open the `legacy-…` drafts and check title/summary, images render (no broken media), captions, photos showing
   people, outdated prices/contacts/events. Edit, then *Publish* (`POST /v1/admin/cms/entries/:id/publish`; the FSM
   records the transition and the audit log the actor). Archive pages that should not go live.
2. **Approve 301s**: *Redirects* tab → unapproved items with source `LEGACY_WONT`; after business sign-off an ADMIN
   (AAL2) approves them (`POST /v1/admin/seo/redirects/approve {"paths":[…]}`). Make sure each target resolves (e.g.
   `/stories/legacy-…` only after that draft is published).
3. **Keep the evidence**: attach `out/report.md`, `out/manifest.json` and `out/import/*` to the change request (PR).

### 커밋 / Commit
```bash
git add apps/web/public/legacy packages/legacy-import/out/{manifest.json,inventory.json,urls.csv,report.md,report.json,import}
```
`out/state`, `out/staging`, `out/snapshots`, `out/build` are git-ignored working state (keep them on the migration
machine for `--resume`; archive `out/snapshots` with the legacy export per the retention policy). If the published set
grows beyond a few hundred MB, move `/legacy/*` to object storage + CDN (5b, `--cdn-base-url`) instead of git.

---

## 7. 롤백 / Rollback

**KO / EN.** 이 도구는 **어떤 파일·행도 스스로 삭제하지 않습니다** (orphans are only reported).

| What | How |
|---|---|
| DEV DB (seed-legacy) | `node packages/db/seed-legacy.mjs --rollback` — removes legacy `property_media`, product `media_ids`, avatars it set, unapproved `LEGACY_WONT` redirects, **unedited** legacy drafts and their refs, legacy `media_assets` no longer referenced; restores placeholder covers from `data.legacyCover.previous`. Edited drafts stay. |
| Published entries | Admin → entry → *Unpublish* / *Archive* (`POST /v1/admin/cms/entries/:id/unpublish` or `/archive`). |
| Redirects | `POST /v1/admin/seo/redirects/approve {"paths":[…],"approved":false}` or `DELETE /v1/admin/seo/redirects?path=…`. |
| API-imported batches (staging/prod) | find the batch: `SELECT id, entity_type, finished_at FROM migration_batches WHERE source='WONT' ORDER BY started_at DESC;` → archive the entries mapped by it (`SELECT new_id FROM migration_id_map WHERE batch_id=$1 AND legacy_type='content'`) through the admin API; unapprove/delete its redirects; media rows are harmless once unreferenced. Forward-fix only — no destructive SQL on production without a backup (`docs/runbooks/db-restore-drill.md`). |
| Files | revert the commit that added `apps/web/public/legacy/<sha12>/…` (or `git rm -r` specific asset dirs). |
| Re-run from scratch | delete `packages/legacy-import/out/state` (and `out/staging` to re-download); assets are content-addressed, so ids and paths stay stable. |

---

## 8. 문제 해결 / Troubleshooting

- **`cannot crawl … robots.txt is unreachable (PROXY_403)`** → 2단계 / step 2.
- **`… (UNREACHABLE_HTTP_503)`** → 사이트가 robots.txt에 5xx 응답: RFC 9309상 전체 금지로 간주, 나중에 재시도 / site
  answers 5xx for robots.txt (treated as disallow-all) — retry later.
- **Coverage is 100 % but a page looks empty** → the page may be rendered client-side; the extractor also scans inline
  scripts/JSON for media URLs, but text rendered only by JavaScript is not captured — copy it manually into the draft.
- **Another run holds the lock** → `out/.lock` with a live pid; stale locks are cleared automatically.
- **Re-crawl later (delta)** → run without `--resume` (fresh crawl; assets are content-addressed, so unchanged files
  keep their ids/paths and are not re-copied; the manifest records the new fetch times), then `seed-legacy` / the API
  CLI again (both idempotent; edited drafts are never overwritten). A `--resume` re-run of a finished migration makes
  no network requests and leaves the manifest byte-identical.
