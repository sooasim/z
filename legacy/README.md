# /legacy — migrated WONT Travel Club media

Images and videos migrated from the legacy WONT Travel Club site (`https://www.wontc.co.kr`, Sixshop) by
`@jetpool/legacy-import` (`packages/legacy-import`). Served by the web app at `<basePath>/legacy/...`.

```
legacy/<sha12>/<name>.<ext>          original file, byte-identical to the legacy download (sha256 = directory prefix)
legacy/<sha12>/<name>-<width>.webp   renditions 480 / 960 / 1600 / 2400 (never upscaled; smaller originals also get a
                                     native-width rendition)
legacy/<sha12>/<name>-poster*.{jpg,webp}   poster frame extracted from a video (only when the page gave none)
```

- `<sha12>` = first 12 hex chars of the original's sha256 — identical files are stored once, ids never change.
- The index of every asset (alt text, caption, source URLs, pages, dimensions, blur placeholder) is
  `packages/legacy-import/out/manifest.json`; DB rows (`media_assets.public_url = /legacy/...`) are created by
  `packages/db/seed-legacy.mjs` (DEV) or `apps/api/scripts/migrate-legacy.ts import-media` (staging/production).
- SVGs with active content (scripts, event handlers, external references) are **not** published as originals — only
  their rasterised webp renditions.
- Do not edit or rename files by hand: re-run the migrator (`--resume`) instead. The migrator never deletes files here;
  directories that are no longer in the manifest are listed as orphans in `out/report.md`.

Note: another pipeline in this repo (`scripts/legacy/optimize.mjs`, data file `data/media/optimized.json`) also publishes
here using the layout `<sha12>/original.<ext>`, `<sha12>/<w>.webp`, `<sha12>/poster.{jpg,webp}` and prunes entries it
did not create. Until one pipeline owns this directory, run `@jetpool/legacy-import` with its own `--public-dir`
(see the runbook's shared-directory warning).

Runbook: `docs/runbooks/legacy-media-import.md`. Content belongs to WONT Travel Club and was migrated with the
owner's authorisation.
