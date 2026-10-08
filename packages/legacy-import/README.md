# @jetpool/legacy-import

MIG-01 migrator for the legacy WONT Travel Club site (Sixshop): polite crawl → media extraction → verified download →
sharp renditions → publish to `apps/web/public/legacy/` + `out/manifest.json` → platform import inputs → reconcile report.
Operator guide (KO/EN): [`docs/runbooks/legacy-media-import.md`](../../docs/runbooks/legacy-media-import.md).

```bash
pnpm --filter @jetpool/legacy-import run migrate -- --start https://www.wontc.co.kr/ --start https://www.wontc.co.kr/about_jetpool \
  [--max-pages 500] [--out packages/legacy-import/out] [--public-dir apps/web/public/legacy] [--resume]
pnpm --filter @jetpool/legacy-import run migrate -- <crawl|extract|download|optimise|publish|import|report|all> [...]
pnpm --filter @jetpool/legacy-import run seed:legacy        # DEV: packages/db/seed-legacy.mjs
pnpm --filter @jetpool/legacy-import run fixture-site       # local fake Sixshop site + CDN for rehearsals
pnpm --filter @jetpool/legacy-import test                   # node:test, fixture site, scratch DB (skips without PG)
```

| Module | Step |
|---|---|
| `src/http.mjs` | polite fetcher: UA `JETPOOL-Migration/1.0 (+owner-authorised)`, concurrency 2, per-host delay (robots Crawl-delay), retries + backoff + Retry-After, manual redirects re-checked against the allowlist, timeouts, byte caps, HTTP(S)_PROXY |
| `src/robots.mjs` | robots.txt (RFC 9309: groups, longest match, `*`/`$`, unreachable ⇒ disallow), sitemap / sitemap index / gzip |
| `src/crawl.mjs` | level-synchronous BFS (deterministic), host allowlist, http/www variants folded onto the start origin, exclusion patterns (login/cart/order/search/template tokens), Sixshop “사용 설명서” template pages flagged, byte-identical pages aliased, HTML snapshots (sha256), linked CSS + `@import` → `inventory.json`, `urls.csv` |
| `src/extract.mjs` | title/meta/og/twitter/canonical/JSON-LD, headings, text blocks (`<br>` kept), links; media: `img` src/srcset/`data-src`/`data-original`/`data-lazy`…, `<picture><source>`, inline + `<style>` + linked CSS `url()`/`image-set()`, og/twitter images, icons, `<video>`/`<source>`/poster, `data-bg`, media URLs in inline scripts/JSON, YouTube/Vimeo embeds |
| `src/download.mjs` | Content-Type + magic-byte verification, caps (image 30 MB / video 300 MB), sha256 dedupe, CDN originals (`?w=` stripped, Sixshop `/thumbnails/…_750.jpg` → original) with both variants kept, provenance, ffprobe |
| `src/optimise.mjs` | sharp webp 480/960/1600/2400 (no upscaling), animated GIF → animated webp, blur placeholder, dominant colour, ffmpeg poster frames |
| `src/publish.mjs` | `<public-dir>/<sha12>/…`, `out/manifest.json` (byte-identical on unchanged re-runs), boilerplate/chrome detection |
| `src/extra-media.mjs` | `--extra-media`: HAR / JSON / CSV of browser-observed media (JavaScript-loaded images) merged into the inventory |
| `src/plan.mjs` | pure manifest → import plan (CMS entries, redirects, listing contexts) shared with `packages/db/seed-legacy.mjs` |
| `src/import.mjs` | `out/import/{plan.json,content.csv,media.csv,redirects.csv}` for `apps/api/scripts/migrate-legacy.ts` |
| `src/report.mjs` | `out/report.md|json`: coverage, failures with reasons, duplicates, bytes, per-page counts; exit 3 below 100 % |
