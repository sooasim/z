export const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** YouTube video id from a watch / share / embed URL (or a bare id). */
export function youtubeId(url: string | null | undefined): string | null {
  const u = String(url || '').trim();
  if (YT_ID.test(u)) return u;
  const m = /^https?:\/\/(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/i.exec(u);
  return m ? m[1] : null;
}
