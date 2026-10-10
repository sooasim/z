'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { assetId, creditedPhotos, mediaReady, useMediaMap, archive } from '@/lib/media';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { ListSkeleton, Icon } from '@/components/ui';
import { Photo } from '@/components/media';
import s from '@/components/media/media.module.css';

const LICENSE_HELP: Record<string, [string, string]> = {
  'CC BY': ['저작자 표시', 'Attribution'],
  'CC BY-SA': ['저작자 표시-동일조건 변경허락', 'Attribution-ShareAlike'],
  CC0: ['퍼블릭 도메인 기증', 'Public domain dedication'],
  'Public Domain Mark': ['퍼블릭 도메인', 'Public domain'],
};
/** Provider metadata sometimes carries markup (Wikimedia: <div class='fn'>Seoul</div>): show plain text only. */
const plain = (v: string | undefined) =>
  String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
const family = (label: string) => (/^cc0/i.test(label) ? 'CC0' : /public domain/i.test(label) ? 'Public Domain Mark' : /by-sa/i.test(label) ? 'CC BY-SA' : /by/i.test(label) ? 'CC BY' : label || '—');

/** Photo credits & licences: every openly-licensed photo shown on JETPOOL with title, creator, licence and source. */
export default function CreditsView() {
  const { L, lang } = useI18n();
  useMediaMap();
  const [lic, setLic] = useState('');
  const rows = creditedPhotos();
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) c.set(family(r.credit.license ?? ''), (c.get(family(r.credit.license ?? '')) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const shown = rows.filter((r) => !lic || family(r.credit.license ?? '') === lic).sort((a, b) => plain(a.credit.title).localeCompare(plain(b.credit.title)));
  const legacyCount = archive().length;
  return (
    <div className={s.wide}>
      <Breadcrumbs items={[{ href: '/about', label: L('브랜드 이야기', 'Our story') }, { label: L('사진 출처·라이선스', 'Photo credits') }]} />
      <header className="page-head">
        <h1 style={{ margin: 0 }}>{L('사진 출처 · 라이선스', 'Photo credits & licences')}</h1>
        <p className="sub">{L('JETPOOL 화면에 쓰인 오픈 라이선스 사진의 작가와 라이선스, 원본을 모두 밝혀요.', 'Every openly-licensed photo used on JETPOOL, with its creator, licence and source.')}</p>
      </header>

      <section className={s.ownerNote} aria-labelledby="owner-h">
        <h2 id="owner-h" style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>
          {L('원여행클럽(WONT) · JETPOOL 자산', 'WONT Travel Club / JETPOOL assets')}
        </h2>
        <p className="small">
          {L(
            `wontc.co.kr에서 옮겨 온 사진·이미지·영상 썸네일${legacyCount ? ` ${legacyCount}점` : ''}은 원여행클럽(WON TRAVEL CLUB) · 젯풀인터내셔날(주) 소유이며, 소유자의 승인을 받아 JETPOOL로 이전했어요. 무단 복제·재배포를 금지합니다.`,
            `The${legacyCount ? ` ${legacyCount}` : ''} photos, images and video thumbnails migrated from wontc.co.kr belong to WONT Travel Club / JETPOOL International and were migrated with the owner’s permission. All rights reserved.`,
          )}{' '}
          <Link href="/archive">{L('브랜드 아카이브 보기', 'See the brand archive')}</Link>
        </p>
        <p className="small muted">
          {L(
            '아래 사진은 크리에이티브 커먼즈(CC BY · CC BY-SA) 또는 퍼블릭 도메인(CC0 · PDM) 사진이에요. 웹 화면에 맞게 크기 조정·잘라내기·WebP 변환을 했어요(변경 사항). 변경금지(ND) 라이선스 사진은 쓰지 않아요. 출처 표기에 문제가 있으면 고객센터로 알려 주세요.',
            'The photos below are Creative Commons (CC BY · CC BY-SA) or public-domain (CC0 · PDM). They were resized, cropped and converted to WebP for the web (changes made). No-derivatives (ND) photos are never used. Spotted a credit problem? Tell our help center.',
          )}
        </p>
        <p className="small muted">
          {L(
            '데모 계정의 프로필 사진도 같은 오픈 라이선스 인물 사진이에요. 사진 속 인물은 해당 호스트·가이드·여행자 본인이 아니며, 예시로 쓰인 사진입니다. 사진이 내려지길 원하시면 고객센터로 알려 주세요.',
            'The profile pictures of the demo accounts are openly-licensed portraits too. The person in a portrait is not the host, guide or traveller it illustrates — they stand in for a demo persona. Ask our help center if you want a portrait taken down.',
          )}
        </p>
      </section>

      {!mediaReady() ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <p className="muted">{L('표시할 라이선스 사진이 없어요.', 'No licensed photos to show.')}</p>
      ) : (
        <>
          <div role="group" aria-label={L('라이선스', 'Licence')} className={s.filters}>
            <button type="button" className="chip" aria-pressed={!lic} onClick={() => setLic('')}>
              {L('전체', 'All')} <span className={s.n}>{rows.length}</span>
            </button>
            {counts.map(([k, n]) => (
              <button key={k} type="button" className="chip" aria-pressed={lic === k} onClick={() => setLic(lic === k ? '' : k)}>
                {k} <span className={s.n}>{n}</span>
              </button>
            ))}
          </div>
          <p className={s.count} aria-live="polite">
            {L(`사진 ${shown.length}장`, `${shown.length} photos`)}
            {lic && LICENSE_HELP[lic] ? ` · ${LICENSE_HELP[lic][lang === 'ko' ? 0 : 1]}` : ''}
          </p>
          <ul className={s.credits}>
            {shown.map(({ url, credit: raw }) => {
              const id = assetId(url)?.split('/')[1];
              const c = { ...raw, title: plain(raw.title), creator: plain(raw.creator) };
              return (
                <li key={url} id={id ? `photo-${id}` : undefined} className={s.credit}>
                  <div className={s.thumb}>
                    <Photo src={url} alt={c.title || ''} sizes="96px" />
                  </div>
                  <div className={s.meta}>
                    <strong title={c.title}>
                      {c.landingUrl ? (
                        <a href={c.landingUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
                          {c.title || L('제목 없음', 'Untitled')}
                        </a>
                      ) : (
                        c.title || L('제목 없음', 'Untitled')
                      )}
                    </strong>
                    <span>
                      {L('작가', 'By')}{' '}
                      {c.creatorUrl ? (
                        <a href={c.creatorUrl} target="_blank" rel="noopener noreferrer">
                          {c.creator || L('미상', 'unknown')}
                        </a>
                      ) : (
                        c.creator || L('미상', 'unknown')
                      )}
                      {c.provider ? ` · ${c.provider}` : ''}
                    </span>
                    <span>
                      {c.licenseUrl ? (
                        <a className={s.licenseTag} href={c.licenseUrl} target="_blank" rel="noopener noreferrer license">
                          {c.license || L('라이선스', 'Licence')}
                        </a>
                      ) : (
                        <span className={s.licenseTag}>{c.license || '—'}</span>
                      )}
                      {c.landingUrl && (
                        <a href={c.landingUrl} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'nowrap' }}>
                          {L('원본 페이지', 'Source page')} <Icon name="external" size={12} style={{ verticalAlign: '-2px' }} />
                        </a>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
