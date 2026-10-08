import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Small shared helpers (no third-party deps). */

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const sha12 = (hex) => hex.slice(0, 12);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Write via temp file + rename so a crash never leaves a truncated state file. */
export async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function writeJson(file, obj) {
  await atomicWrite(file, JSON.stringify(obj, null, 2) + '\n');
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (err.code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

export async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

/** Copy only when the destination is missing or differs in size (keeps mtimes stable on re-runs). */
export async function copyIfChanged(src, dest) {
  const [a, b] = await Promise.all([fileSize(src), fileSize(dest)]);
  if (a < 0) throw new Error(`missing source file ${src}`);
  if (a === b) return false;
  await ensureDir(path.dirname(dest));
  const tmp = `${dest}.${process.pid}.tmp`;
  await copyFile(src, tmp);
  await rename(tmp, dest);
  return true;
}

export async function removeIfExists(p) {
  if (existsSync(p)) await rm(p, { recursive: true, force: true });
}

/** RFC 4180 CSV writer; UTF-8 BOM so Excel opens Korean text correctly (the API parser strips it). */
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Same slug rules as apps/api migration/parse.ts slugify (keeps Hangul). */
export function slugify(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** ASCII-only, filesystem/URL-safe base name (no extension). */
export function safeBaseName(raw, fallback = 'file') {
  let s = String(raw ?? '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || fallback;
}

/** Same as apps/api cms/service.ts normalizePath (seo_redirects.legacy_path format). */
export function normalizeLegacyPath(input) {
  let s = String(input).trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      s = u.pathname + u.search;
    }
  } catch {
    /* keep raw */
  }
  s = s.split('#')[0];
  const qi = s.indexOf('?');
  let p = qi >= 0 ? s.slice(0, qi) : s;
  const qs = qi >= 0 ? s.slice(qi + 1) : undefined;
  try {
    p = decodeURI(p);
  } catch {
    /* leave encoded */
  }
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return qs ? `${p}?${qs}` : p;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Most frequent non-empty string (ties → first seen). */
export function mostCommon(values) {
  const counts = new Map();
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
}

export const uniq = (arr) => [...new Set(arr.filter((x) => x !== undefined && x !== null && x !== ''))];

/** Simple bounded worker pool. */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createLogger({ quiet = false, stream = process.stderr } = {}) {
  const out = (level, msg) => {
    if (quiet && level === 'info') return;
    stream.write(`[legacy-import] ${level === 'info' ? '' : level.toUpperCase() + ': '}${msg}\n`);
  };
  return { info: (m) => out('info', m), warn: (m) => out('warn', m), error: (m) => out('error', m) };
}
