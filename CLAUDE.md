# JETPOOL monorepo

- Product/spec source: `dd/` (start with `dd/README_START_HERE.md`, `dd/AGENTS_MASTER.md`).
- Plan / checklist / agent roles: `docs/PLAN.md`, `docs/CHECKLIST.md`.
- Binding engineering rules: `docs/CONVENTIONS.md` (read before changing code).
- API: `apps/api` (Fastify + PostgreSQL). Tests: `cd apps/api && npx vitest run` (needs PostgreSQL on localhost:5432).
- Web: `apps/web` (Next.js). DB migrations: `packages/db/migrations` (forward-only).
- UI languages (ko/en/ja/zh/vi): `docs/I18N.md` — read it before touching `lib/dict.ts`, `lib/phrases.ts` or `L(...)` copy.
- Home-screen app icon, in-app-browser escape (KakaoTalk) and app auto-login: `docs/APP_INSTALL.md` — read it before touching `lib/inapp.ts`, `components/public/AppInstall.tsx`, `app/app/`, the manifest or the refresh-cookie path.
