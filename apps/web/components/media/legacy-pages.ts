/**
 * The 34 pages captured from wontc.co.kr and where their content lives on JETPOOL now. Used for archive filters,
 * captions and "see where this image is used" links. CMS entries carry `data.legacyUrl`; when the CMS knows a
 * page, its route wins (see `legacyPageRoute(page, cmsRoutes)`), this table is the fallback.
 */
export interface LegacyPage {
  ko: string;
  en: string;
  route: string;
  group: 'brand' | 'service' | 'letter' | 'tour' | 'site';
}

export const LEGACY_PAGES: Record<string, LegacyPage> = {
  '/': { ko: '원여행클럽 홈', en: 'WONT home', route: '/stories/wontc-home', group: 'site' },
  '/about_wontc': { ko: '원여행클럽 소개', en: 'About WONT Travel Club', route: '/about/about-wontc', group: 'brand' },
  '/about_ceo': { ko: 'CEO 원치승', en: 'CEO Michael Won', route: '/about/about-ceo', group: 'brand' },
  '/about_jetpool': { ko: '젯풀인터내셔날', en: 'JETPOOL International', route: '/about/about-jetpool', group: 'brand' },
  '/about_letter': { ko: '마음편지', en: 'Heart letters', route: '/stories/about-letter', group: 'letter' },
  '/won_story': { ko: '원스토리', en: 'WON story', route: '/about/won-story', group: 'brand' },
  '/jetpool': { ko: '젯풀호스트 프랜차이즈', en: 'JETPOOL host franchise', route: '/about/jetpool-host', group: 'service' },
  '/local_life': { ko: '한달살기 맞교환 여행', en: 'Month-long exchange trips', route: '/about/local-life', group: 'service' },
  '/member_stay': { ko: '멤버 스테이', en: 'Member stay', route: '/about/member-stay', group: 'service' },
  '/tour_consulting': { ko: '여행 컨설팅', en: 'Travel consulting', route: '/about/tour-consulting', group: 'service' },
  '/tour_ticket': { ko: '투어&티켓', en: 'Tours & tickets', route: '/about/tour-ticket', group: 'service' },
  '/untitled-1': { ko: '전세기 공유 플랫폼', en: 'Charter sharing platform', route: '/about/charter-platform', group: 'service' },
  '/untitled-6': { ko: '프리미엄 라운지 · 행잉 가든스 오브 발리', en: 'Premium lounge · Hanging Gardens of Bali', route: '/stories/hanging-gardens-of-bali', group: 'service' },
  '/cs': { ko: '고객센터', en: 'Customer center', route: '/about/customer-center', group: 'site' },
  '/guide': { ko: '사용 설명서', en: 'Site guide', route: '/stories/sixshop-guide', group: 'site' },
  '/notice_guide': { ko: '공지 · 사용 설명서', en: 'Notice guide', route: '/stories/sixshop-notice-guide', group: 'site' },
  '/qna_guide': { ko: 'Q&A · 사용 설명서', en: 'Q&A guide', route: '/stories/sixshop-qna-guide', group: 'site' },
  '/review_guide': { ko: '리뷰 · 사용 설명서', en: 'Review guide', route: '/stories/sixshop-review-guide', group: 'site' },
  '/product/past_operafestival': { ko: '[축제] 오페라 페스티벌', en: 'Opera festival tour', route: '/stories/wont-opera-festival', group: 'tour' },
  '/product/past_operafestival-28': { ko: '[축제] 오페라 페스티벌 (2)', en: 'Opera festival tour (2)', route: '/stories/wont-opera-festival-copy', group: 'tour' },
  '/product/past_pilgrimage': { ko: '[종교] 마틴 루터 종교개혁 성지순례', en: 'Martin Luther pilgrimage', route: '/stories/wont-luther-pilgrimage', group: 'tour' },
  '/product/past_spainbest': { ko: '[푸드] 미식과 미학의 베스트 스페인', en: 'Best of Spain food tour', route: '/stories/wont-spain-gastronomy', group: 'tour' },
  '/product/past_spainbest-30': { ko: '[힐링] 캐나다 여행', en: 'Canada healing trip', route: '/stories/wont-canada-healing', group: 'tour' },
  '/product/past_spainbest-30-31': { ko: '나태주 선생과 함께하는 삿포로 눈축제', en: 'Sapporo snow festival with Na Tae-ju', route: '/stories/wont-sapporo-snow-festival', group: 'tour' },
  '/product/past_spainbest-30-31-32': { ko: '유영만 교수와 떠나는 바르셀로나 인문학 여행', en: 'Barcelona humanities trip with Prof. Yu Young-man', route: '/stories/wont-barcelona-humanities', group: 'tour' },
  '/blogPost/heat_letter_01': { ko: '[마음편지 01] MBC 체험수기 금상', en: 'Heart letter 01', route: '/stories/heart-letter-01', group: 'letter' },
  '/blogPost/heart_letter_02': { ko: '[마음편지 02] 한국관광의 기본개념', en: 'Heart letter 02', route: '/stories/heart-letter-02', group: 'letter' },
  '/blogPost/heart_letter_03': { ko: '[마음편지 03] 서울관광마케팅 설립에 부쳐', en: 'Heart letter 03', route: '/stories/heart-letter-03', group: 'letter' },
  '/blogPost/heart_letter_04': { ko: '[마음편지 04] 리옹 빛 축제', en: 'Heart letter 04', route: '/stories/heart-letter-04', group: 'letter' },
  '/blogPost/heart_letter_05': { ko: '[마음편지 05] 화제의 편지 – 답신', en: 'Heart letter 05', route: '/stories/heart-letter-05', group: 'letter' },
  '/blogPost/heart_letter_06': { ko: '[마음편지 06] 극동패키지 초안', en: 'Heart letter 06', route: '/stories/heart-letter-06', group: 'letter' },
  '/blogPost/heart_letter_07': { ko: '[마음편지 07] 20세기의 마지막 편', en: 'Heart letter 07', route: '/stories/heart-letter-07', group: 'letter' },
  '/blogPost/heart_letter_08': { ko: '[마음편지 08] 첫 편지 3년 후', en: 'Heart letter 08', route: '/stories/heart-letter-08', group: 'letter' },
  '/blogPost/heart_letter_09': { ko: '[마음편지 09] 2013년 부활호', en: 'Heart letter 09', route: '/stories/heart-letter-09', group: 'letter' },
};

/** '/about_ceo' for 'https://www.wontc.co.kr/about_ceo', 'about_ceo', '/about_ceo/' … ('' when unknown/empty). */
export function legacyPageKey(page: string | null | undefined): string {
  let p = String(page || '').trim();
  if (!p) return '';
  p = p.replace(/^https?:\/\/(?:www\.)?wontc\.co\.kr/i, '').split(/[?#]/)[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

export function legacyPageLabel(page: string | null | undefined, lang: 'ko' | 'en' = 'ko'): string {
  const key = legacyPageKey(page);
  const hit = LEGACY_PAGES[key];
  if (hit) return hit[lang];
  if (!key) return lang === 'ko' ? '기타' : 'Other';
  return key.replace(/^\//, '').replace(/[_-]+/g, ' ');
}

/** New platform route for a legacy page; CMS-known routes (legacyUrl → path) take precedence. */
export function legacyPageRoute(page: string | null | undefined, cmsRoutes?: Map<string, string>): string | undefined {
  const key = legacyPageKey(page);
  if (!key) return undefined;
  return cmsRoutes?.get(key) ?? LEGACY_PAGES[key]?.route;
}
