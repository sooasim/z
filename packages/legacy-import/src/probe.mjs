import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import sharp from 'sharp';

sharp.cache(false);

/** Image dimensions via sharp (EXIF orientation applied); ICO/BMP fall back to header parsing. */
export async function imageInfo(file, mime) {
  try {
    const m = await sharp(file, { failOn: 'none', animated: true, limitInputPixels: 268_402_689 }).metadata();
    const rotated = (m.orientation ?? 1) >= 5;
    const height = m.pageHeight && m.pages > 1 ? m.pageHeight : m.height;
    return {
      width: rotated ? height : m.width,
      height: rotated ? m.width : height,
      format: m.format,
      pages: m.pages ?? 1,
      animated: (m.pages ?? 1) > 1,
      hasAlpha: !!m.hasAlpha,
      orientation: m.orientation ?? null,
      sharp: true,
    };
  } catch (err) {
    const fh = await open(file, 'r');
    try {
      const { buffer } = await fh.read(Buffer.alloc(64), 0, 64, 0);
      if (mime === 'image/x-icon') {
        const w = buffer[6] || 256;
        const h = buffer[7] || 256;
        return { width: w, height: h, format: 'ico', pages: buffer.readUInt16LE(4), animated: false, sharp: false };
      }
      if (mime === 'image/bmp') return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)), format: 'bmp', pages: 1, animated: false, sharp: false };
    } finally {
      await fh.close();
    }
    return { width: null, height: null, format: null, sharp: false, error: String(err?.message ?? err).slice(0, 200) };
  }
}

function run(bin, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: String(e.message) });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

/** Video duration/dimensions via ffprobe when available, else null fields (step is skipped). */
export async function videoInfo(file, ffprobe) {
  if (!ffprobe) return { durationMs: null, width: null, height: null, codec: null, probed: false };
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  if (r.code !== 0) return { durationMs: null, width: null, height: null, codec: null, probed: false, error: r.err.slice(0, 200) };
  try {
    const j = JSON.parse(r.out);
    const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
    const dur = Number(j.format?.duration ?? v?.duration);
    return {
      durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      codec: v?.codec_name ?? null,
      hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'),
      probed: true,
    };
  } catch {
    return { durationMs: null, width: null, height: null, codec: null, probed: false };
  }
}

/** Extract one frame (≈1 s in, or the first frame for short clips) as JPEG via ffmpeg. */
export async function extractPosterFrame(file, dest, ffmpeg, durationMs) {
  if (!ffmpeg) return false;
  const ss = durationMs && durationMs > 2000 ? '1' : '0';
  const r = await run(ffmpeg, ['-v', 'error', '-y', '-ss', ss, '-i', file, '-frames:v', '1', '-q:v', '2', dest], 120_000);
  return r.code === 0;
}
