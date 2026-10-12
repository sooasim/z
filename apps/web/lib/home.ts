/**
 * The main (`/`) page as editable content.
 *
 * Everything on the home page has a built-in bilingual default in `app/view.tsx` (the `L(ko, en)` copy that
 * `lib/phrases.ts` translates into ja/zh/vi). The admin console (`/admin/home`) stores *overrides* in a CMS
 * `PAGE` entry with slug `home`, one entry per locale — so an untouched field keeps its five-language default
 * and only what an editor actually typed is pinned to that one language. That is why every field here is
 * optional and why the view reads `cfg.hero.title || L('…', '…')` rather than merging objects.
 *
 * Shape of `cms_entries.data` for slug `home`:
 *   { hero: {eyebrow,title,lead}, shortcuts: [...], destinations: [...],
 *     rails: { stays: {show,title,subtitle}, ... }, blocks: [...], trust: [...] }
 *
 * `blocks` predates this file (the brand blocks have always come from CMS `data.blocks`), so its field names
 * are kept as they are.
 */
import type { IconName } from '@/components/ui';
import { arr, f, isObj, str, type Obj } from './shape';

export const HOME_SLUG = 'home';
/** Brand blocks used to live on this slug alone; still read as a fallback so migrated content keeps working. */
export const LEGACY_HOME_SLUG = 'wont-home';

export interface HomeHero {
  eyebrow: string;
  title: string;
  lead: string;
}

export interface HomeShortcut {
  label: string;
  href: string;
  icon: IconName | '';
}

export interface HomeDestination {
  /** Canonical (English) city name — used for the `/stay?q=` link and the photo lookup. */
  name: string;
  /** What the card shows; empty falls back to `name`. */
  label: string;
  tag: string;
  image: string;
}

export interface HomeRailConfig {
  show: boolean;
  title: string;
  subtitle: string;
}

export interface HomeBlock {
  key: string;
  title: string;
  body: string;
  cta: string;
  href: string;
  image: string;
}

export interface HomeTrustItem {
  icon: IconName | '';
  title: string;
  body: string;
}

/** The rails between the hero and the brand blocks, in render order. */
export const RAIL_KEYS = ['stays', 'exchange', 'guides', 'tours'] as const;
export type RailKey = (typeof RAIL_KEYS)[number];

export interface HomeConfig {
  hero: HomeHero;
  shortcuts: HomeShortcut[];
  destinations: HomeDestination[];
  rails: Record<RailKey, HomeRailConfig>;
  blocks: HomeBlock[];
  trust: HomeTrustItem[];
}

const EMPTY_HERO: HomeHero = { eyebrow: '', title: '', lead: '' };
const emptyRail = (): HomeRailConfig => ({ show: true, title: '', subtitle: '' });

/** An override set that changes nothing — the home page renders its built-in copy. */
export function emptyHomeConfig(): HomeConfig {
  return {
    hero: { ...EMPTY_HERO },
    shortcuts: [],
    destinations: [],
    rails: Object.fromEntries(RAIL_KEYS.map((k) => [k, emptyRail()])) as Record<RailKey, HomeRailConfig>,
    blocks: [],
    trust: [],
  };
}

/** Site-relative path or absolute http(s) URL; anything else (`javascript:`…) is dropped. */
function safeHref(v: string): string {
  const s = v.trim();
  if (!s) return '';
  if (s.startsWith('//') || /[\r\n]/.test(s)) return '';
  return s.startsWith('/') || /^https?:\/\//i.test(s) ? s : '';
}

const icon = (v: string): IconName | '' => (/^[a-z][a-z-]*$/.test(v.trim()) ? (v.trim() as IconName) : '');
const postcardArt = (v: string): string => (/^[a-z0-9-]{1,40}$/.test(v.trim()) ? `/art/postcards/${v.trim()}.svg` : '');

/**
 * Read `cms_entries.data` into a `HomeConfig`. Tolerant on purpose: the entry is hand-editable JSON in the
 * CMS screen too, so a half-filled or hand-mangled object must never break the home page.
 */
export function readHomeConfig(data: unknown): HomeConfig {
  const d: Obj = isObj(data) ? data : {};
  const cfg = emptyHomeConfig();
  const hero = f<Obj>(d, 'hero');
  if (isObj(hero)) cfg.hero = { eyebrow: str(hero, 'eyebrow'), title: str(hero, 'title'), lead: str(hero, 'lead', 'subtitle') };

  cfg.shortcuts = arr<Obj>(d, 'shortcuts')
    .map((s) => ({ label: str(s, 'label', 'title'), href: safeHref(str(s, 'href', 'url', 'link')), icon: icon(str(s, 'icon')) }))
    .filter((s) => s.label && s.href);

  cfg.destinations = arr<Obj>(d, 'destinations')
    .map((x) => ({ name: str(x, 'name', 'en', 'city'), label: str(x, 'label', 'ko'), tag: str(x, 'tag'), image: safeHref(str(x, 'image', 'imageUrl', 'photoUrl')) }))
    .filter((x) => x.name || x.label);

  const rails = f<Obj>(d, 'rails');
  if (isObj(rails)) {
    for (const k of RAIL_KEYS) {
      const r = f<Obj>(rails, k);
      if (!isObj(r)) continue;
      cfg.rails[k] = { show: f<boolean>(r, 'show', 'enabled') !== false, title: str(r, 'title'), subtitle: str(r, 'subtitle') };
    }
  }

  cfg.blocks = arr<Obj>(d, 'blocks')
    .map((b, i) => ({
      key: str(b, 'key', 'id') || String(i),
      title: str(b, 'title'),
      body: str(b, 'body', 'summary', 'text'),
      cta: str(b, 'cta', 'ctaLabel'),
      href: safeHref(str(b, 'href', 'url', 'link')),
      // `art` is the pre-existing field name for a postcard behind a brand block; fold it into `image` so
      // content authored before this screen keeps its picture and the editor has one field, not two.
      image: safeHref(str(b, 'image', 'imageUrl', 'photoUrl')) || postcardArt(str(b, 'art')),
    }))
    .filter((b) => b.title || b.body);

  cfg.trust = arr<Obj>(d, 'trust')
    .map((t) => ({ icon: icon(str(t, 'icon')), title: str(t, 'title'), body: str(t, 'body', 'text') }))
    .filter((t) => t.title || t.body);

  return cfg;
}

/**
 * What still applies when the entry is in a language the reader does not read: hiding a section is a
 * structural decision about the page, not copy, so it holds for everyone. Every text override is dropped —
 * Korean (or English) copy must not reach a ja/zh/vi reader (docs/I18N.md).
 */
export function structuralHomeConfig(cfg: HomeConfig): HomeConfig {
  const out = emptyHomeConfig();
  for (const k of RAIL_KEYS) out.rails[k].show = cfg.rails[k].show;
  return out;
}

/** Drop empty strings and empty lists so the stored entry holds only real overrides. */
export function writeHomeConfig(cfg: HomeConfig): Obj {
  const out: Obj = {};
  const hero = Object.fromEntries(Object.entries(cfg.hero).filter(([, v]) => v.trim()));
  if (Object.keys(hero).length) out.hero = hero;
  if (cfg.shortcuts.length) out.shortcuts = cfg.shortcuts.filter((s) => s.label.trim() && s.href.trim());
  if (cfg.destinations.length) out.destinations = cfg.destinations.filter((x) => x.name.trim() || x.label.trim());
  const rails = Object.fromEntries(
    RAIL_KEYS.map((k) => [k, cfg.rails[k]]).filter(([, r]) => !(r as HomeRailConfig).show || (r as HomeRailConfig).title.trim() || (r as HomeRailConfig).subtitle.trim()),
  );
  if (Object.keys(rails).length) out.rails = rails;
  if (cfg.blocks.length) out.blocks = cfg.blocks.filter((b) => b.title.trim() || b.body.trim());
  if (cfg.trust.length) out.trust = cfg.trust.filter((t) => t.title.trim() || t.body.trim());
  return out;
}
