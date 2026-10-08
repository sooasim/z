/** Magic-byte detection. Returns { mime, ext, kind: 'image'|'video'|'document'|'text' } or null. */
export function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  const at = (off, ...bytes) => bytes.every((x, i) => b[off + i] === x);
  const ascii = (off, len) => b.subarray(off, off + len).toString('latin1');
  if (at(0, 0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return { mime: 'video/x-msvideo', ext: 'avi', kind: 'video' };
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const major = ascii(8, 4);
    const boxLen = Math.min(b.readUInt32BE(0), b.length);
    const compat = [];
    for (let off = 16; off + 4 <= boxLen; off += 4) compat.push(ascii(off, 4));
    const brands = [major, ...compat];
    if (brands.includes('avif') || brands.includes('avis')) return { mime: 'image/avif', ext: 'avif', kind: 'image' };
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(major)) return { mime: 'image/heic', ext: 'heic', kind: 'image' };
    if (major === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    if (major === 'M4V ' || major === 'M4VH' || major === 'M4VP') return { mime: 'video/x-m4v', ext: 'm4v', kind: 'video' };
    if (major === 'M4A ' || major === 'M4B ') return { mime: 'audio/mp4', ext: 'm4a', kind: 'audio' };
    return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) {
    const head = ascii(0, Math.min(b.length, 64));
    return head.includes('webm') ? { mime: 'video/webm', ext: 'webm', kind: 'video' } : { mime: 'video/x-matroska', ext: 'mkv', kind: 'video' };
  }
  if (ascii(0, 4) === 'OggS') return { mime: 'video/ogg', ext: 'ogv', kind: 'video' };
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return { mime: 'image/x-icon', ext: 'ico', kind: 'image' };
  if (at(0, 0x00, 0x00, 0x02, 0x00)) return { mime: 'image/x-icon', ext: 'cur', kind: 'image' };
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return { mime: 'image/tiff', ext: 'tif', kind: 'image' };
  if (ascii(0, 2) === 'BM' && b.length > 26) return { mime: 'image/bmp', ext: 'bmp', kind: 'image' };
  if (ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', kind: 'document' };
  // text formats
  let text = b.subarray(0, Math.min(b.length, 2048)).toString('utf8');
  text = text.replace(/^\ufeff/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text) || (/^<\?xml/i.test(text) && /<svg[\s>]/i.test(text))) return { mime: 'image/svg+xml', ext: 'svg', kind: 'image' };
  if (/^<(!doctype html|html|head|body)/i.test(text)) return { mime: 'text/html', ext: 'html', kind: 'text' };
  if (/^[{[]/.test(text)) return { mime: 'application/json', ext: 'json', kind: 'text' };
  return null;
}

/** Content-Type values a CDN may legitimately send for media we sniff ourselves. */
export function contentTypeAcceptable(ct, sniffed) {
  const t = (ct ?? '').toLowerCase();
  if (!t || ['application/octet-stream', 'binary/octet-stream', 'application/x-download', 'application/download', 'application/force-download'].includes(t)) return true;
  if (t.startsWith('image/') || t.startsWith('video/')) return true;
  if (sniffed?.kind === 'image' && sniffed.mime === 'image/svg+xml' && (t === 'text/xml' || t === 'application/xml' || t === 'text/plain')) return true;
  if (t === 'application/mp4' || t === 'application/ogg') return true;
  return false;
}

/** SVG is published as an original only when it carries no active content (scripts, handlers, external refs). */
export function svgIsSafe(text) {
  const s = String(text ?? '');
  if (/<script[\s>]/i.test(s)) return false;
  if (/\son[a-z]+\s*=/i.test(s)) return false;
  if (/<foreignObject[\s>]/i.test(s)) return false;
  if (/(href|src)\s*=\s*["']\s*(javascript|data:text\/html|https?:)/i.test(s)) return false;
  if (/<!ENTITY/i.test(s)) return false;
  if (/@import|url\(\s*['"]?\s*(https?:|javascript:)/i.test(s)) return false;
  return true;
}
