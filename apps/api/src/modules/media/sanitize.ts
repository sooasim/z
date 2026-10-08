/**
 * STAY-02: strip privacy-sensitive metadata (EXIF incl. GPS, XMP, IPTC, comments, embedded secondary images,
 * MP4 user-data / location atoms) from media BEFORE it is copied to the public CDN bucket. Phone photos of a home
 * usually carry the exact GPS position, which the listing design deliberately hides (fuzzed public coordinates).
 *
 * Pure byte-level rewriting, no native deps, no re-encoding (pixels are untouched):
 *  - JPEG: drop APP1 (Exif/XMP), APP3–APP13 (incl. Photoshop/IPTC), APP15, COM, non-ICC APP2 (MPF) and anything
 *          after the primary image's EOI; keep JFIF/ICC/Adobe and all coding segments. A non-default EXIF
 *          Orientation is preserved as a minimal one-tag EXIF block so photos do not display rotated.
 *  - PNG:  drop eXIf / tEXt / zTXt / iTXt (XMP) / tIME chunks and trailing data after IEND.
 *  - WebP: drop EXIF / XMP chunks and clear the VP8X metadata flags.
 *  - MP4:  rename moov/udta, moov/meta, trak/udta, trak/meta and XMP uuid boxes to 'free' (same size → every chunk
 *          offset stays valid).
 *  - AVIF: zero the payload of Exif and XMP items (offsets unchanged); fails closed when an Exif/XMP item cannot be
 *          located.
 * Parsing is lenient for malformed trailing structure (the remainder is copied as-is) except where noted.
 */
export class MediaSanitizeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MediaSanitizeError';
  }
}

export function stripMetadata(bytes: Buffer, mime: string): Buffer {
  try {
    return strip(bytes, mime);
  } catch (err) {
    // deterministic for a given file: surface as a sanitize failure (the upload is refused), never as a transient error
    if (err instanceof MediaSanitizeError) throw err;
    throw new MediaSanitizeError(`malformed ${mime} structure (${(err as Error)?.message ?? err})`);
  }
}

function strip(bytes: Buffer, mime: string): Buffer {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    case 'video/mp4':
      return stripMp4(bytes);
    case 'image/avif':
      return stripAvif(bytes);
    default:
      return bytes;
  }
}

// ------------------------------------------------------------------------------------------------ JPEG

function readExifOrientation(seg: Buffer): number | null {
  // seg = FF E1 <len> 'Exif\0\0' <TIFF>
  const tiff = 10;
  if (seg.length < tiff + 8) return null;
  const order = seg.toString('latin1', tiff, tiff + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o: number) => (le ? seg.readUInt16LE(o) : seg.readUInt16BE(o));
  const u32 = (o: number) => (le ? seg.readUInt32LE(o) : seg.readUInt32BE(o));
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > seg.length) return null;
  const n = u16(ifd0);
  for (let k = 0; k < n; k++) {
    const e = ifd0 + 2 + k * 12;
    if (e + 12 > seg.length) return null;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** APP1 segment holding only IFD0/Orientation (no GPS, no maker notes, no thumbnail). */
function orientationApp1(orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // 'MM', 42, IFD0 @ 8
    0x00, 0x01, // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT x1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function keepJpegSegment(marker: number, seg: Buffer): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker >= 0xe0 && marker <= 0xef) {
    if (marker === 0xe0) return true; // JFIF / JFXX
    if (marker === 0xe2) return seg.length >= 16 && seg.toString('latin1', 4, 16) === 'ICC_PROFILE\0'; // colour profile only
    if (marker === 0xee) return seg.length >= 9 && seg.toString('latin1', 4, 9) === 'Adobe'; // colour transform flag
    return false; // APP1 Exif/XMP, APP13 IPTC/Photoshop, MPF, vendor blocks
  }
  return true; // coding segments (SOFn, DHT, DQT, DRI, ...)
}

function stripJpeg(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const out: Buffer[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let insertAt = 1; // index in `out` after which the orientation block goes (after SOI, or after a leading APP0)
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff || i + 1 >= b.length) {
      out.push(b.subarray(i)); // malformed: keep the rest verbatim
      break;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      out.push(b.subarray(i, i + 2)); // EOI of the primary image: drop trailers / MPF secondary images
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) {
      out.push(b.subarray(i));
      break;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) {
      out.push(b.subarray(i));
      break;
    }
    if (marker === 0xda) {
      // start of scan: header + entropy-coded data up to the next real marker
      let j = i + 2 + len;
      while (j < b.length) {
        if (b[j] === 0xff && j + 1 < b.length) {
          const n = b[j + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
            j += n === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push(b.subarray(i, j));
      i = j;
      continue;
    }
    const seg = b.subarray(i, i + 2 + len);
    if (marker === 0xe1 && seg.length >= 10 && seg.toString('latin1', 4, 10) === 'Exif\0\0') orientation = readExifOrientation(seg) ?? orientation;
    if (keepJpegSegment(marker, seg)) {
      out.push(seg);
      if (marker === 0xe0 && out.length === 2) insertAt = 2;
    }
    i += 2 + len;
  }
  if (orientation && orientation !== 1) out.splice(insertAt, 0, orientationApp1(orientation));
  return Buffer.concat(out);
}

// ------------------------------------------------------------------------------------------------ PNG

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Buffer): Buffer {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return b;
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i < b.length) {
    if (i + 12 > b.length) {
      out.push(b.subarray(i));
      break;
    }
    const len = b.readUInt32BE(i);
    const end = i + 12 + len;
    if (end > b.length) {
      out.push(b.subarray(i));
      break;
    }
    const type = b.toString('latin1', i + 4, i + 8);
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break; // drop trailing data
  }
  return Buffer.concat(out);
}

// ------------------------------------------------------------------------------------------------ WebP

function stripWebp(b: Buffer): Buffer {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return b;
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  const out: Buffer[] = [];
  let i = 12;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) {
      out.push(b.subarray(i, riffEnd));
      break;
    }
    const fourcc = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > riffEnd) {
      out.push(b.subarray(i, riffEnd));
      break;
    }
    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      i = Math.min(end, riffEnd);
      continue;
    }
    const chunk = Buffer.from(b.subarray(i, Math.min(end, riffEnd)));
    if (fourcc === 'VP8X' && chunk.length > 8) chunk[8] &= ~(0x08 | 0x04); // EXIF + XMP present flags
    out.push(chunk);
    i = Math.min(end, riffEnd);
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------------------------------------ ISO BMFF (MP4 / AVIF)

interface Box { type: string; start: number; headerSize: number; end: number }

function boxes(b: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    let headerSize = 8;
    if (size === 1) {
      if (i + 16 > to) break;
      const big = b.readBigUInt64BE(i + 8);
      if (big > BigInt(to - i)) break;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = to - i;
    }
    if (size < headerSize || i + size > to) break;
    out.push({ type, start: i, headerSize, end: i + size });
    i += size;
  }
  return out;
}

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

/** Turn a box into padding: type 'free' (ignored by players) and its payload zeroed (no readable leftovers). */
function renameToFree(b: Buffer, box: Box) {
  b.write('free', box.start + 4, 'latin1');
  b.fill(0, box.start + box.headerSize, box.end);
}

function stripMp4(src: Buffer): Buffer {
  const b = Buffer.from(src);
  const scrubContainer = (box: Box) => {
    for (const child of boxes(b, box.start + box.headerSize, box.end)) {
      if (child.type === 'udta' || child.type === 'meta') renameToFree(b, child); // user data: ©xyz, loci, Apple keys...
      else if (child.type === 'trak') scrubContainer(child);
    }
  };
  for (const top of boxes(b, 0, b.length)) {
    if (top.type === 'moov') scrubContainer(top);
    else if (top.type === 'meta' || top.type === 'udta') renameToFree(b, top);
    else if (top.type === 'uuid' && top.end - top.start >= 24 && b.toString('hex', top.start + 8, top.start + 24) === XMP_UUID) renameToFree(b, top);
  }
  return b;
}

function readUInt(b: Buffer, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return b.readUInt32BE(at);
  if (size === 8) return Number(b.readBigUInt64BE(at));
  if (size === 2) return b.readUInt16BE(at);
  throw new MediaSanitizeError(`unsupported field size ${size}`);
}

function stripAvif(src: Buffer): Buffer {
  const b = Buffer.from(src);
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return b;
  const body = meta.start + meta.headerSize + 4; // FullBox
  const children = boxes(b, body, meta.end);
  // 1) metadata items: Exif, and 'mime' items carrying XMP
  const sensitive = new Set<number>();
  const iinf = children.find((x) => x.type === 'iinf');
  if (iinf) {
    const v = b[iinf.start + iinf.headerSize];
    let p = iinf.start + iinf.headerSize + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxes(b, p, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const iv = b[infe.start + infe.headerSize];
      if (iv < 2) continue;
      p = infe.start + infe.headerSize + 4;
      const itemId = iv === 2 ? b.readUInt16BE(p) : b.readUInt32BE(p);
      p += (iv === 2 ? 2 : 4) + 2; // + item_protection_index
      const itemType = b.toString('latin1', p, p + 4);
      p += 4;
      if (itemType === 'Exif') sensitive.add(itemId);
      else if (itemType === 'mime') {
        const nameEnd = b.indexOf(0, p);
        const ctEnd = nameEnd >= 0 ? b.indexOf(0, nameEnd + 1) : -1;
        const contentType = nameEnd >= 0 && ctEnd > nameEnd && ctEnd <= infe.end ? b.toString('latin1', nameEnd + 1, ctEnd) : '';
        if (/xmp|rdf\+xml/i.test(contentType)) sensitive.add(itemId);
      }
    }
  }
  if (!sensitive.size) return b;
  // 2) locate their bytes through iloc and zero them
  const iloc = children.find((x) => x.type === 'iloc');
  if (!iloc) throw new MediaSanitizeError('AVIF metadata item without iloc');
  const idat = children.find((x) => x.type === 'idat');
  const v = b[iloc.start + iloc.headerSize];
  let p = iloc.start + iloc.headerSize + 4;
  const offsetSize = b[p] >> 4, lengthSize = b[p] & 0x0f;
  const baseOffsetSize = b[p + 1] >> 4, indexSize = v === 1 || v === 2 ? b[p + 1] & 0x0f : 0;
  p += 2;
  const count = v < 2 ? b.readUInt16BE(p) : b.readUInt32BE(p);
  p += v < 2 ? 2 : 4;
  const zeroed = new Set<number>();
  for (let k = 0; k < count; k++) {
    if (p > iloc.end) throw new MediaSanitizeError('truncated iloc');
    const itemId = v < 2 ? b.readUInt16BE(p) : b.readUInt32BE(p);
    p += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) {
      method = b.readUInt16BE(p) & 0x0f;
      p += 2;
    }
    p += 2; // data_reference_index
    const base = readUInt(b, p, baseOffsetSize);
    p += baseOffsetSize;
    const extents = b.readUInt16BE(p);
    p += 2;
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const off = readUInt(b, p, offsetSize);
      p += offsetSize;
      const len = readUInt(b, p, lengthSize);
      p += lengthSize;
      if (!sensitive.has(itemId)) continue;
      let start: number;
      if (method === 0) start = base + off;
      else if (method === 1 && idat) start = idat.start + idat.headerSize + base + off;
      else throw new MediaSanitizeError('unsupported AVIF item construction for a metadata item');
      if (len === 0 || start + len > b.length) throw new MediaSanitizeError('AVIF metadata extent out of range');
      b.fill(0, start, start + len);
      zeroed.add(itemId);
    }
  }
  for (const id of sensitive) if (!zeroed.has(id)) throw new MediaSanitizeError('AVIF metadata item has no locatable data');
  return b;
}
