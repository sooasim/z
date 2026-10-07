import { post } from './api';
import { item, str, f } from './shape';

export const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** API media purposes (STAY-02). Documents (PDF) are only accepted for VERIFICATION / EVIDENCE. */
export type MediaPurpose = 'PROPERTY' | 'AVATAR' | 'VERIFICATION' | 'EVIDENCE' | 'MESSAGE' | 'CMS' | 'TRAVEL_PRODUCT' | 'GUIDE';

export function validateUpload(file: { type: string; size: number }, allowed = ALLOWED_IMAGE, max = MAX_IMAGE_BYTES): string | null {
  if (!allowed.includes(file.type)) return 'UNSUPPORTED_TYPE';
  if (file.size > max) return 'FILE_TOO_LARGE';
  if (file.size === 0) return 'EMPTY_FILE';
  return null;
}

export async function sha256Hex(file: Blob): Promise<string | undefined> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle || file.size > 50 * 1024 * 1024) return undefined;
    const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/** Parse POST /v1/media/upload-url → { media: {id}, upload: {url, method, headers} } (tolerates flat shapes). */
export function parseUploadTicket(res: unknown) {
  const r = item(res) ?? {};
  return {
    id: str(r, 'media.id', 'mediaId', 'id'),
    url: str(r, 'upload.url', 'uploadUrl', 'url'),
    method: (str(r, 'upload.method', 'method') || 'PUT').toUpperCase(),
    headers: (f<Record<string, string>>(r, 'upload.headers', 'headers') ?? {}) as Record<string, string>,
  };
}

/**
 * Presigned upload: 1) POST /v1/media/upload-url 2) PUT bytes straight to object storage (never through the web
 * server) 3) POST /v1/media/:id/complete so the API sniffs/validates and processes it. Returns the media id.
 */
export async function presignedUpload(file: File, purpose: MediaPurpose, onProgress?: (pct: number) => void): Promise<string> {
  const sha256 = await sha256Hex(file);
  const t = parseUploadTicket(await post('/v1/media/upload-url', { purpose, mimeType: file.type || 'application/octet-stream', byteSize: file.size, sha256 }));
  if (!t.url || !t.id) throw new Error('Upload ticket missing');
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(t.method, t.url);
    const headers = { 'content-type': file.type, ...t.headers };
    Object.entries(headers).forEach(([k, v]) => k.toLowerCase() !== 'host' && xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(file);
  });
  await post(`/v1/media/${t.id}/complete`, {});
  return t.id;
}
