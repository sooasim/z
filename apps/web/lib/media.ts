import { post } from './api';
import { item, str, f } from './shape';

export const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function validateUpload(file: { type: string; size: number }, allowed = ALLOWED_IMAGE, max = MAX_IMAGE_BYTES): string | null {
  if (!allowed.includes(file.type)) return 'UNSUPPORTED_TYPE';
  if (file.size > max) return 'FILE_TOO_LARGE';
  if (file.size === 0) return 'EMPTY_FILE';
  return null;
}

/**
 * Presigned upload (STAY-02): 1) POST /v1/media/upload-url → {mediaId, uploadUrl, method, headers|fields}
 * 2) PUT the bytes directly to object storage 3) POST /v1/media/:id/complete so the API verifies & processes.
 */
export async function presignedUpload(file: File, meta: Record<string, unknown>, onProgress?: (pct: number) => void): Promise<string> {
  const res = await post('/v1/media/upload-url', { contentType: file.type, fileName: file.name, sizeBytes: file.size, ...meta });
  const u = item(res);
  const url = str(u, 'uploadUrl', 'url', 'presignedUrl');
  const id = str(u, 'mediaId', 'id', 'assetId', 'media.id');
  const method = (str(u, 'method') || 'PUT').toUpperCase();
  const headers = (f<Record<string, string>>(u, 'headers') ?? {}) as Record<string, string>;
  const fields = f<Record<string, string>>(u, 'fields');
  if (url) {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      let body: Document | XMLHttpRequestBodyInit = file;
      if (method === 'POST' && fields) {
        const fd = new FormData();
        Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
        fd.append('file', file);
        body = fd;
      } else {
        xhr.setRequestHeader('content-type', file.type);
        Object.entries(headers).forEach(([k, v]) => k.toLowerCase() !== 'host' && xhr.setRequestHeader(k, v));
      }
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.send(body);
    });
  }
  if (id) await post(`/v1/media/${id}/complete`, {});
  return id;
}
