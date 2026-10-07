import { createHash } from 'node:crypto';

/** MIG-01 pure helpers: CSV parsing, normalisation, legacy-format classification, URL inventory. */

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** RFC 4180 CSV (quoted fields, escaped quotes, CRLF, embedded newlines, UTF-8 BOM). Header keys are trimmed. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** First non-empty value among alias column names (case-insensitive). */
export function pick(row: Record<string, string>, aliases: string[]): string | null {
  const keys = Object.keys(row);
  for (const a of aliases) {
    const k = keys.find((x) => x.toLowerCase() === a.toLowerCase());
    if (k && row[k] !== undefined && row[k] !== '') return row[k];
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase().normalize('NFKC');
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

/** Korean numbers → E.164 (+82…); international numbers kept when already '+'-prefixed. */
export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('82') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) return `+82${digits.slice(1)}`;
  return null;
}

export type PasswordFormat = 'SCRYPT_COMPATIBLE' | 'BCRYPT' | 'MD5' | 'SHA1' | 'SHA256' | 'PLAINTEXT_OR_UNKNOWN' | 'NONE';

/**
 * Only hashes verifiable by platform/crypto.verifyPassword (scrypt$N$r$p$salt$hash) are migrated.
 * Anything else is NOT stored and the user is flagged for a password reset.
 */
export function classifyPasswordHash(hash: string | null, declared?: string | null): PasswordFormat {
  if (!hash) return 'NONE';
  if (/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(hash)) return 'SCRYPT_COMPATIBLE';
  const d = (declared ?? '').toLowerCase();
  if (/^\$2[aby]\$\d{2}\$/.test(hash) || d.includes('bcrypt')) return 'BCRYPT';
  if (/^[a-f0-9]{32}$/i.test(hash) || d === 'md5') return 'MD5';
  if (/^[a-f0-9]{40}$/i.test(hash) || d === 'sha1') return 'SHA1';
  if (/^[a-f0-9]{64}$/i.test(hash) || d.includes('sha256')) return 'SHA256';
  return 'PLAINTEXT_OR_UNKNOWN';
}

export function parseBoolConsent(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (['y', 'yes', 'true', '1', '동의', 'agree', 'o'].includes(v)) return true;
  if (['n', 'no', 'false', '0', '거부', '미동의', 'disagree', 'x'].includes(v)) return false;
  return null;
}

export function parseLegacyDate(raw: string | null): Date | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\./g, '-').replace(/\//g, '-');
  const d = new Date(/^\d{4}-\d{1,2}-\d{1,2}$/.test(s) ? `${s}T00:00:00+09:00` : s.includes('T') || /[+Z]/.test(s) ? s : `${s.replace(' ', 'T')}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function slugify(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Legacy HTML → safe markdown-ish text. Scripts/styles/handlers are dropped; images and links are kept as markdown. */
export function htmlToMarkdown(html: string): { markdown: string; images: string[] } {
  const images: string[] = [];
  let s = html
    .replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, (_m, src: string) => {
      if (/^javascript:/i.test(src)) return '';
      images.push(src);
      return `![](${src})`;
    })
    .replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => (/^javascript:/i.test(href) ? text : `[${text.replace(/<[^>]+>/g, '')}](${href})`))
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `${'#'.repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m).replace(/\n{3,}/g, '\n\n').trim();
  return { markdown: s, images: [...new Set(images)] };
}

export interface InventoryItem { url: string; path: string; kind: string; hash: string }

/** URL inventory from a sitemap.xml (<loc>) or a CSV with a url column. */
export function buildUrlInventory(text: string): { items: InventoryItem[]; hash: string; sourceKind: 'sitemap' | 'csv' } {
  const isXml = /<urlset|<sitemapindex|<loc>/i.test(text);
  const urls = isXml
    ? [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
    : parseCsv(text).map((r) => pick(r, ['url', 'legacy_url', 'loc', 'address'])).filter((u): u is string => !!u);
  const seen = new Set<string>();
  const items: InventoryItem[] = [];
  for (const url of urls) {
    let path: string;
    try {
      const u = new URL(url, 'https://legacy.invalid');
      path = (u.pathname.replace(/\/+$/, '') || '/') + u.search;
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const kind = /\/(shop|product|item|goods)/i.test(path) ? 'product' : /\/(board|notice|post|blog|story|magazine)/i.test(path) ? 'content' : /\.(jpe?g|png|gif|webp)$/i.test(path) ? 'media' : 'page';
    items.push({ url, path, kind, hash: sha256Hex(url) });
  }
  return { items, hash: sha256Hex(text), sourceKind: isXml ? 'sitemap' : 'csv' };
}
