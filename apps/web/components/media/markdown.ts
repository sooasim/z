/**
 * Pure Markdown helpers for migrated CMS content (no React): block parser, media references, excerpts.
 * Rendering lives in RichMarkdown.tsx.
 */
import { assetId } from '@/lib/media';
import { youtubeId } from './youtube';


export interface MdImage {
  alt: string;
  src: string;
  title?: string;
  href?: string;
}
export type MdBlock =
  | { t: 'h'; level: number; text: string }
  | { t: 'hr' }
  | { t: 'p'; lines: string[]; note?: boolean }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'images'; images: MdImage[] }
  | { t: 'video'; id: string; title: string; thumb?: string; caption?: string };

export const IMG = String.raw`!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)`;
const IMG_LINE = new RegExp(`^${IMG}$`);
const LINKED_IMG_LINE = new RegExp(String.raw`^\[${IMG}\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$`);
const VIDEO_NOTE = /^(?:▶|►|▷)\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–-]\s*(.+))?$/;

/** Only site-relative paths and http(s) URLs are ever rendered (no javascript:, data: etc.). */
export const safeUrl = (u: string) => (u.startsWith('/') && !u.startsWith('//')) || /^https?:\/\//i.test(u);

function stripFrontMatter(src: string): string {
  if (!src.startsWith('---\n')) return src;
  const end = src.indexOf('\n---', 4);
  if (end < 0) return src;
  const head = src.slice(4, end);
  return /^[a-zA-Z_]+:/m.test(head) ? src.slice(end + 4).replace(/^\s*\n/, '') : src;
}

const normTitle = (t: string) => t.replace(/[\\*_`#\s]/g, '').toLowerCase();

/**
 * Line-based Markdown → blocks. Supports headings, paragraphs (hard line breaks kept), lists, quotes, rules,
 * images, linked images (YouTube watch links become lite embeds) and the "▶ [title](youtube) — date" caption line.
 * `dropTitle` removes a leading `# heading` equal to the page title (the page renders its own <h1>).
 */
export function parseMarkdown(source: string, opts: { dropTitle?: string } = {}): MdBlock[] {
  const src = stripFrontMatter(String(source || '').replace(/\r\n?/g, '\n'));
  const out: MdBlock[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] | null = null;
  let lastWasImage = false;
  const flush = () => {
    if (para.length) out.push({ t: 'p', lines: para, note: /^\*?\s*(원본|출처|source)\s*:/i.test(para[0]) });
    if (list) out.push(list);
    if (quote) out.push({ t: 'quote', lines: quote });
    para = [];
    list = null;
    quote = null;
  };
  const pushImage = (img: MdImage) => {
    const prev = out[out.length - 1];
    if (lastWasImage && prev?.t === 'images') prev.images.push(img);
    else out.push({ t: 'images', images: [img] });
    lastWasImage = true;
  };
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const tr = line.trim();
    if (!tr) {
      flush();
      continue; // blank lines keep consecutive images grouped
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(tr))) {
      flush();
      lastWasImage = false;
      out.push({ t: 'h', level: m[1].length, text: m[2] });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(tr)) {
      flush();
      lastWasImage = false;
      out.push({ t: 'hr' });
      continue;
    }
    if ((m = LINKED_IMG_LINE.exec(tr))) {
      flush();
      const [, alt, img, title, href] = m;
      const vid = youtubeId(href);
      if (vid) {
        lastWasImage = false;
        out.push({ t: 'video', id: vid, title: alt || title || '', thumb: safeUrl(img) ? img : undefined });
      } else if (safeUrl(img)) pushImage({ alt, src: img, title, href: safeUrl(href) ? href : undefined });
      continue;
    }
    if ((m = IMG_LINE.exec(tr))) {
      flush();
      if (safeUrl(m[2])) pushImage({ alt: m[1], src: m[2], title: m[3] });
      continue;
    }
    if ((m = VIDEO_NOTE.exec(tr))) {
      const id = youtubeId(m[2]);
      const prev = out[out.length - 1];
      if (id && prev?.t === 'video' && prev.id === id && !para.length) {
        prev.caption = m[3] ? `${m[1]} — ${m[3]}` : m[1];
        if (!prev.title) prev.title = m[1];
        continue;
      }
      if (id && !para.length) {
        flush();
        lastWasImage = false;
        out.push({ t: 'video', id, title: m[1], caption: m[3] ? `${m[1]} — ${m[3]}` : m[1] });
        continue;
      }
    }
    lastWasImage = false;
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line)) && !para.length && !quote) {
      if (list?.t !== 'ul') {
        flush();
        list = { t: 'ul', items: [] };
      }
      list.items.push(m[1]);
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line)) && !para.length && !quote) {
      if (list?.t !== 'ol') {
        flush();
        list = { t: 'ol', items: [] };
      }
      list.items.push(m[1]);
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(tr))) {
      if (!quote) {
        flush();
        quote = [];
      }
      quote.push(m[1]);
      continue;
    }
    if (list || quote) flush();
    para.push(tr.replace(/\\$/, ''));
  }
  flush();
  // Drop a leading "# Title" that repeats the page title.
  if (opts.dropTitle) {
    const first = out.findIndex((b) => b.t !== 'hr');
    const b = out[first];
    if (b && b.t === 'h' && normTitle(b.text) === normTitle(opts.dropTitle)) out.splice(first, 1);
  }
  return out;
}

/** Image and video references in a Markdown body (used to de-duplicate galleries / embed lists). */
export function markdownMedia(source: string): { images: string[]; videos: string[] } {
  const images: string[] = [];
  const videos: string[] = [];
  for (const b of parseMarkdown(source)) {
    if (b.t === 'images') images.push(...b.images.map((i) => i.src));
    if (b.t === 'video') {
      videos.push(b.id);
      if (b.thumb) images.push(b.thumb);
    }
    if (b.t === 'p') for (const l of b.lines) for (const m of l.matchAll(new RegExp(IMG, 'g'))) images.push(m[2]);
  }
  return { images, videos };
}

/** Plain-text excerpt from the first paragraphs (images, links, emphasis and escapes stripped). */
export function markdownExcerpt(source: string, n = 90): string {
  const text = parseMarkdown(source)
    .filter((b): b is Extract<MdBlock, { t: 'p' }> => b.t === 'p' && !b.note)
    .map((b) => b.lines.join(' '))
    .join(' ')
    .replace(new RegExp(IMG, 'g'), '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? `${text.slice(0, n).trim()}…` : text;
}

/** First image of a Markdown body (cover fallback). */
export const markdownCover = (source: string): string | undefined => markdownMedia(source).images[0];

/** Same asset regardless of variant / basePath. */
export const sameAsset = (a: string, b: string) => (assetId(a) && assetId(a) === assetId(b)) || a === b;
