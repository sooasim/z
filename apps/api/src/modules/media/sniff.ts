/** Magic-byte sniffing: the declared MIME type is never trusted on its own (STAY-02 acceptance). */
export function sniffMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = Math.min(b.readUInt32BE(0), b.length);
    const brands: string[] = [b.toString('ascii', 8, 12)];
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(b.toString('ascii', i, i + 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'image/avif';
    if (brands.some((x) => ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'MSNV'].includes(x))) return 'video/mp4';
  }
  return null;
}

/** Best-effort width/height extraction for PNG, JPEG and WebP (no native deps). */
export function imageDimensions(b: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp' && b.length >= 30) {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}
