import { describe, expect, it, beforeEach } from 'vitest';
import { assetId, canonicalUrl, cityPhoto, credit, creditedPhotos, guideCover, imgProps, indexMediaMap, personPhoto, setMediaMap, stripBase, withBase, pick, archive } from '@/lib/media';
import { canonicalPlace } from '@/lib/places';
import { postcardFor, realize, isArt } from '@/lib/art';
import { markdownExcerpt, markdownMedia, parseMarkdown } from '@/components/media/markdown';
import { youtubeId } from '@/components/media/youtube';
import { legacyPageKey, legacyPageLabel, legacyPageRoute } from '@/components/media/legacy-pages';

const MAP = {
  photos: {
    '/photos/aaaaaaaaaaaa/960.webp': {
      srcset: '/photos/aaaaaaaaaaaa/480.webp 480w, /photos/aaaaaaaaaaaa/960.webp 960w',
      placeholder: 'data:image/webp;base64,AAAA',
      width: 1024,
      height: 768,
      colorAvg: '#747674',
      credit: { title: "<div class='fn'>Jet</div>", creator: 'Someone', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/', landingUrl: 'https://flickr.com/x' },
    },
    '/photos/bbbbbbbbbbbb/960.webp': { srcset: '/photos/bbbbbbbbbbbb/480.webp 480w', colorAvg: '#111111', credit: { creator: 'B', license: 'CC0 1.0' } },
  },
  legacy: { '/legacy/cccccccccccc/960.webp': { srcset: '/legacy/cccccccccccc/480.webp 480w, /legacy/cccccccccccc/960.webp 960w', alt: '원치승 대표', width: 1000, height: 692 } },
  cities: { Jeju: '/photos/aaaaaaaaaaaa/960.webp', 'Chiang Mai': '/photos/bbbbbbbbbbbb/960.webp' },
  guides: { 'user-1': '/photos/bbbbbbbbbbbb/960.webp' },
  people: {
    byId: { 'user-1': '/photos/aaaaaaaaaaaa/960.webp' },
    byName: { '서울 호스트': '/photos/bbbbbbbbbbbb/960.webp' },
    pool: ['/photos/aaaaaaaaaaaa/960.webp', '/photos/bbbbbbbbbbbb/960.webp'],
  },
  hero: ['/legacy/cccccccccccc/960.webp'],
  charter: ['/photos/aaaaaaaaaaaa/960.webp'],
  archive: [{ url: '/legacy/cccccccccccc/960.webp', alt: 'x', page: '/about_ceo' }],
  embeds: [{ provider: 'youtube', id: 'Y6e0UurHw4g', title: 'MBC', thumb: '/legacy/a85f35a45cb2/480.webp' }],
};

describe('media map', () => {
  beforeEach(() => setMediaMap(MAP));

  it('identifies assets by id across variants, basePath and origins', () => {
    expect(assetId('/photos/aaaaaaaaaaaa/480.webp')).toBe('photos/aaaaaaaaaaaa');
    expect(assetId('/legacy/cccccccccccc/original.jpg?x=1')).toBe('legacy/cccccccccccc');
    expect(assetId('http://localhost:4000/legacy/cccccccccccc/700.webp')).toBe('legacy/cccccccccccc');
    expect(assetId('/art/postcards/jeju.svg')).toBeNull();
    expect(canonicalUrl('/legacy/cccccccccccc/700.webp')).toBe('/legacy/cccccccccccc/960.webp');
  });

  it('adds the basePath exactly once and leaves external URLs alone (no basePath in tests)', () => {
    expect(withBase('/photos/x/960.webp')).toBe('/photos/x/960.webp');
    expect(withBase('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe('https://i.ytimg.com/vi/x/hqdefault.jpg');
    expect(withBase('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(stripBase('/photos/x/960.webp')).toBe('/photos/x/960.webp');
  });

  it('builds responsive img props with placeholder background', () => {
    const p = imgProps('/photos/aaaaaaaaaaaa/960.webp');
    expect(p.src).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(p.srcSet).toBe('/photos/aaaaaaaaaaaa/480.webp 480w, /photos/aaaaaaaaaaaa/960.webp 960w');
    expect(p.sizes).toBeTruthy();
    expect(p.width).toBe(1024);
    expect(p.style.backgroundColor).toBe('#747674');
    expect(p.style.backgroundImage).toContain('data:image/webp');
    expect(p.loading).toBe('lazy');
    // unknown URLs pass through without srcset
    const u = imgProps('/uploads/abc.jpg');
    expect(u.src).toBe('/uploads/abc.jpg');
    expect(u.srcSet).toBeUndefined();
  });

  it('resolves city photos by name, Korean alias and slug-ish spellings', () => {
    expect(cityPhoto('Jeju')).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(cityPhoto('제주', canonicalPlace)).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(cityPhoto('chiang-mai')).toBe('/photos/bbbbbbbbbbbb/960.webp');
    expect(cityPhoto('Atlantis')).toBeUndefined();
    expect(guideCover('user-1')).toBe('/photos/bbbbbbbbbbbb/960.webp');
  });

  it('resolves profile photos by user id, display name and a stable pool pick', () => {
    expect(personPhoto('user-1')).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(personPhoto(undefined, '서울 호스트')).toBe('/photos/bbbbbbbbbbbb/960.webp');
    // an unknown person still gets a face, and always the same one
    const unknown = personPhoto('user-99', '이서연');
    expect(unknown).toBeTruthy();
    expect(personPhoto('user-99', '이서연')).toBe(unknown);
    expect(personPhoto('', null)).toBeUndefined();
    // no portraits in the map → the caller falls back to the initial
    setMediaMap({ ...MAP, people: { byId: {}, byName: {}, pool: [] } });
    expect(personPhoto('user-1', '서울 호스트')).toBeUndefined();
    setMediaMap(MAP);
  });

  it('exposes credits for licensed photos only', () => {
    expect(credit('/photos/aaaaaaaaaaaa/480.webp')?.creator).toBe('Someone');
    expect(credit('/photos/aaaaaaaaaaaa/480.webp')?.title).toBe('Jet');
    expect(credit('/legacy/cccccccccccc/960.webp')).toBeUndefined();
    expect(creditedPhotos()).toHaveLength(2);
    expect(archive()).toHaveLength(1);
  });

  it('upgrades postcard art to real photos once the map is loaded', () => {
    expect(postcardFor('제주시 애월읍')).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(realize('/art/postcards/jeju.svg')).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(realize('/z/art/postcards/chiangmai.svg')).toBe('/photos/bbbbbbbbbbbb/960.webp');
    expect(isArt(realize('/art/postcards/coast.svg'))).toBe(false);
    expect(realize('/photos/aaaaaaaaaaaa/960.webp')).toBe('/photos/aaaaaaaaaaaa/960.webp');
    expect(pick(['a', 'b', 'c'], 'seed')).toBe(pick(['a', 'b', 'c'], 'seed'));
  });

  it('tolerates a broken map', () => {
    const ix = indexMediaMap({ photos: 'nope', cities: null, archive: [{ nourl: 1 }] });
    expect(ix.map.archive).toEqual([]);
    expect(ix.byId.size).toBe(0);
  });
});

describe('markdown (migrated CMS bodies)', () => {
  const md = [
    '---',
    'title: "CEO 원치승"',
    '---',
    '',
    '# CEO 원치승',
    '',
    '## ABOUT',
    '',
    '언제나 한결같은 마음으로  ',
    '가족처럼 모시는 \\<원여행클럽> 입니다.',
    '',
    '![대표 사진](/legacy/cccccccccccc/960.webp)',
    '',
    '![콜로세움](/legacy/dddddddddddd/700.webp)',
    '',
    '[![MBC 방송](/legacy/a85f35a45cb2/480.webp)](https://www.youtube.com/watch?v=Y6e0UurHw4g)',
    '',
    '▶ [MBC 방송](https://www.youtube.com/watch?v=Y6e0UurHw4g) — 1998년 5월 27일',
    '',
    '- 하나',
    '- 둘',
    '',
    '![bad](javascript:alert(1))',
    '',
    '*원본: https://www.wontc.co.kr/about_ceo · 소유자 승인*',
  ].join('\n');

  it('parses headings, grouped images, lite video embeds with captions and drops the duplicate title', () => {
    const b = parseMarkdown(md, { dropTitle: 'CEO 원치승' });
    expect(b[0]).toEqual({ t: 'h', level: 2, text: 'ABOUT' });
    expect(b[1]).toMatchObject({ t: 'p', lines: ['언제나 한결같은 마음으로', '가족처럼 모시는 \\<원여행클럽> 입니다.'] });
    const imgs = b.find((x) => x.t === 'images');
    expect(imgs && imgs.t === 'images' && imgs.images.map((i) => i.src)).toEqual(['/legacy/cccccccccccc/960.webp', '/legacy/dddddddddddd/700.webp']);
    const v = b.find((x) => x.t === 'video');
    expect(v).toMatchObject({ t: 'video', id: 'Y6e0UurHw4g', thumb: '/legacy/a85f35a45cb2/480.webp', caption: 'MBC 방송 — 1998년 5월 27일' });
    expect(b.filter((x) => x.t === 'p' && x.lines[0].startsWith('▶'))).toHaveLength(0);
    expect(b.find((x) => x.t === 'ul')).toEqual({ t: 'ul', items: ['하나', '둘'] });
    const media = b.flatMap((x) => (x.t === 'images' ? x.images.map((i) => i.src) : x.t === 'video' ? [x.thumb ?? ''] : []));
    expect(media.some((u) => /^\s*(javascript|data|vbscript):/i.test(u))).toBe(false);
    expect(b[b.length - 1]).toMatchObject({ t: 'p', note: true });
  });

  it('lists media references and builds plain excerpts', () => {
    const m = markdownMedia(md);
    expect(m.videos).toEqual(['Y6e0UurHw4g']);
    expect(m.images).toContain('/legacy/cccccccccccc/960.webp');
    expect(m.images).toContain('/legacy/a85f35a45cb2/480.webp');
    const ex = markdownExcerpt(md, 200);
    expect(ex).toContain('가족처럼 모시는 <원여행클럽>');
    expect(ex).not.toContain('![');
    expect(ex).not.toContain('원본:');
  });

  it('parses YouTube ids only from YouTube URLs', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=Y6e0UurHw4g')).toBe('Y6e0UurHw4g');
    expect(youtubeId('https://youtu.be/UJtI-b0bMLY')).toBe('UJtI-b0bMLY');
    expect(youtubeId('https://www.youtube-nocookie.com/embed/eyudvDHROuE')).toBe('eyudvDHROuE');
    expect(youtubeId('https://evil.example/watch?v=Y6e0UurHw4g')).toBeNull();
  });
});

describe('legacy pages', () => {
  it('normalises legacy URLs and maps them to platform routes', () => {
    expect(legacyPageKey('https://www.wontc.co.kr/about_ceo')).toBe('/about_ceo');
    expect(legacyPageKey('about_ceo/')).toBe('/about_ceo');
    expect(legacyPageLabel('/about_ceo')).toBe('CEO 원치승');
    expect(legacyPageRoute('/blogPost/heat_letter_01')).toBe('/stories/heart-letter-01');
    expect(legacyPageRoute('/about_ceo', new Map([['/about_ceo', '/about/x']]))).toBe('/about/x');
  });
});
