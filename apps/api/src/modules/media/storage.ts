import { mkdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../../platform/config.js';
import { hmacSha256, safeEqual } from '../../platform/crypto.js';

export const STORAGE_ADAPTER = 'storage';

/**
 * STAY-02 object storage contract. Uploads land in the PRIVATE bucket; only processed, approved
 * media of a public purpose is copied to the PUBLIC (CDN) bucket.
 */
export interface StorageAdapter {
  readonly kind: 'S3' | 'LOCAL';
  presignPut(o: { mediaId: string; key: string; mimeType: string; byteSize: number; expiresSec: number }): Promise<{ url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string }>;
  /** size of a private object, or null when missing */
  head(key: string): Promise<{ size: number } | null>;
  /** read a private object fully (bounded by the media size limits) */
  read(key: string): Promise<Buffer>;
  /** copy a private object to the public bucket under publicKey */
  promote(key: string, publicKey: string, mimeType: string): Promise<void>;
  publicUrl(publicKey: string): string;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly kind = 'S3' as const;
  private s3: S3Client;
  constructor(private cfg: Config) {
    this.s3 = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT,
      forcePathStyle: !!cfg.S3_ENDPOINT,
      credentials: cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } : undefined,
    });
  }

  async presignPut(o: { key: string; mimeType: string; byteSize: number; expiresSec: number }) {
    const cmd = new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET_PRIVATE, Key: o.key, ContentType: o.mimeType, ContentLength: o.byteSize });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: o.expiresSec });
    return { url, method: 'PUT' as const, headers: { 'content-type': o.mimeType }, expiresAt: new Date(Date.now() + o.expiresSec * 1000).toISOString() };
  }

  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.S3_BUCKET_PRIVATE, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async read(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET_PRIVATE, Key: key }));
    return Buffer.from(await (r.Body as any).transformToByteArray());
  }

  async promote(key: string, publicKey: string, mimeType: string) {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.cfg.S3_BUCKET_PUBLIC,
        Key: publicKey,
        CopySource: `${this.cfg.S3_BUCKET_PRIVATE}/${key.split('/').map(encodeURIComponent).join('/')}`,
        ContentType: mimeType,
        MetadataDirective: 'REPLACE',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  publicUrl(publicKey: string) {
    return `${this.cfg.CDN_BASE_URL.replace(/\/$/, '')}/${publicKey}`;
  }
}

/**
 * Dev/test storage: bytes on local disk. "Presigned" URLs point at PUT /v1/media/dev-upload/:id with an
 * HMAC token (same semantics as an S3 presign: bound to one object, content type and expiry).
 * Refused in production.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'LOCAL' as const;
  readonly root: string;
  constructor(private cfg: Config, root?: string) {
    if (cfg.NODE_ENV === 'production') throw new Error('local media storage is forbidden in production; configure S3_*');
    this.root = root ?? path.join(tmpdir(), 'jetpool-media');
  }

  private safe(dir: 'private' | 'public', key: string) {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return path.join(this.root, dir, key);
  }

  token(mediaId: string, mimeType: string, exp: number) {
    return `${exp}.${hmacSha256(this.cfg.JWT_SECRET, `dev-upload:${mediaId}:${mimeType}:${exp}`)}`;
  }

  verifyToken(mediaId: string, mimeType: string, token: string | undefined): boolean {
    if (!token) return false;
    const [expStr, sig] = token.split('.');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !sig) return false;
    return safeEqual(this.token(mediaId, mimeType, exp), token);
  }

  async presignPut(o: { mediaId: string; mimeType: string; expiresSec: number }) {
    const exp = Math.floor(Date.now() / 1000) + o.expiresSec;
    const url = `${this.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/media/dev-upload/${o.mediaId}?token=${encodeURIComponent(this.token(o.mediaId, o.mimeType, exp))}`;
    return { url, method: 'PUT' as const, headers: { 'content-type': o.mimeType }, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async writePrivate(key: string, bytes: Buffer) {
    const p = this.safe('private', key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async head(key: string) {
    try {
      const s = await stat(this.safe('private', key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async read(key: string) {
    return readFile(this.safe('private', key));
  }

  async promote(key: string, publicKey: string) {
    const dst = this.safe('public', publicKey);
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(this.safe('private', key), dst);
  }

  async readPublic(publicKey: string) {
    return readFile(this.safe('public', publicKey));
  }

  publicUrl(publicKey: string) {
    return `${this.cfg.CDN_BASE_URL.replace(/\/$/, '')}/${publicKey}`;
  }
}

export function createStorage(cfg: Config): StorageAdapter {
  const useS3 = !!(cfg.S3_ENDPOINT || cfg.S3_ACCESS_KEY_ID || cfg.NODE_ENV === 'production');
  return useS3 ? new S3StorageAdapter(cfg) : new LocalStorageAdapter(cfg);
}
