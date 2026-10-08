'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { embedById, useMediaMap } from '@/lib/media';
import { Photo } from './Photo';
import { YT_ID } from './youtube';
import s from './media.module.css';
export { youtubeId } from './youtube';

/**
 * Privacy-enhanced "lite" YouTube embed: shows the locally migrated thumbnail and only loads the
 * youtube-nocookie.com player (no cookies before play) when the visitor clicks. CSP: frame-src youtube-nocookie.
 */
export function LiteYouTube({ id, title, thumb, date, caption }: { id: string; title?: string; thumb?: string; date?: string; caption?: string }) {
  const { L } = useI18n();
  useMediaMap();
  const [on, setOn] = useState(false);
  if (!YT_ID.test(id)) return null;
  const meta = embedById(id);
  const name = title || meta?.title || L('동영상', 'Video');
  const poster = thumb || meta?.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const when = date || meta?.dateText || meta?.date;
  return (
    <figure className={s.videoFigure}>
      {on ? (
        <div className={s.yt}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
            title={name}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : (
        <button type="button" className={s.yt} onClick={() => setOn(true)} aria-label={L(`동영상 재생: ${name}`, `Play video: ${name}`)}>
          <Photo src={poster} alt="" sizes="(max-width: 780px) 100vw, 780px" />
          <span className={s.ytTitle}>{name}</span>
          <span className={s.play} aria-hidden="true" />
          <span className={s.ytMeta}>
            <span>YouTube</span>
            {when && <span>· {when}</span>}
          </span>
        </button>
      )}
      <figcaption>
        {caption || (when ? `${name} — ${when}` : name)}
        <span className={s.ytNote} style={{ display: 'block' }}>
          {L('재생 버튼을 누르면 YouTube(개인정보 보호 모드)에서 영상을 불러와요.', 'The video loads from YouTube (privacy-enhanced mode) only when you press play.')}{' '}
          <a href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noopener noreferrer">
            {L('YouTube에서 보기', 'Watch on YouTube')}
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
