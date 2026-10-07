import { z } from 'zod';

/**
 * AI-01 deterministic (offline) travel intent parser for Korean/English. Pure functions only: user text is
 * treated as untrusted data and can only ever produce a bounded, validated TravelIntent (read-only search input).
 */

export const MODES = ['stay', 'exchange', 'guide', 'travel'] as const;
export type Mode = (typeof MODES)[number];
export const INTERESTS = ['beach', 'food', 'cafe', 'hiking', 'nature', 'history', 'shopping', 'art', 'nightlife', 'spa', 'photo', 'family', 'hanok', 'kculture'] as const;
export type Interest = (typeof INTERESTS)[number];

export const travelIntentSchema = z.object({
  destination: z.object({ city: z.string().min(1).max(50), aliases: z.array(z.string().min(1).max(50)).max(10) }).nullable(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  nights: z.number().int().min(1).max(90).nullable(),
  guests: z.number().int().min(1).max(50).nullable(),
  budget: z.object({ amountMinor: z.number().int().positive().max(1e12), currency: z.enum(['KRW', 'USD']), per: z.enum(['TOTAL', 'NIGHT', 'PERSON']) }).nullable(),
  interests: z.array(z.enum(INTERESTS)).max(INTERESTS.length),
  modes: z.array(z.enum(MODES)).min(1).max(4),
  language: z.enum(['ko', 'en']),
});
export type TravelIntent = z.infer<typeof travelIntentSchema>;

/** canonical (Korean) name, English name, extra aliases */
const CITIES: Array<[string, string, string[]]> = [
  ['서울', 'Seoul', ['서울시', '홍대', '강남', '종로', '이태원', '성수']],
  ['부산', 'Busan', ['Pusan', '해운대', 'Haeundae', '광안리']],
  ['제주', 'Jeju', ['제주도', '서귀포', 'Seogwipo', '애월']],
  ['강릉', 'Gangneung', []],
  ['속초', 'Sokcho', []],
  ['경주', 'Gyeongju', []],
  ['전주', 'Jeonju', []],
  ['여수', 'Yeosu', []],
  ['인천', 'Incheon', []],
  ['대구', 'Daegu', []],
  ['대전', 'Daejeon', []],
  ['광주', 'Gwangju', []],
  ['수원', 'Suwon', []],
  ['춘천', 'Chuncheon', []],
  ['통영', 'Tongyeong', []],
  ['안동', 'Andong', []],
  ['가평', 'Gapyeong', []],
  ['양양', 'Yangyang', []],
  ['도쿄', 'Tokyo', ['동경']],
  ['오사카', 'Osaka', []],
  ['교토', 'Kyoto', []],
  ['후쿠오카', 'Fukuoka', []],
  ['삿포로', 'Sapporo', []],
  ['방콕', 'Bangkok', []],
  ['다낭', 'Da Nang', ['Danang']],
  ['타이베이', 'Taipei', ['타이페이']],
  ['싱가포르', 'Singapore', []],
  ['파리', 'Paris', []],
  ['런던', 'London', []],
  ['뉴욕', 'New York', ['NYC']],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveCity(text: string): { city: string; aliases: string[] } | null {
  let best: { idx: number; entry: [string, string, string[]] } | null = null;
  for (const entry of CITIES) {
    const [ko, en, extra] = entry;
    for (const name of [ko, en, ...extra]) {
      const isLatin = /^[A-Za-z .]+$/.test(name);
      const re = isLatin ? new RegExp(`\\b${escapeRe(name)}\\b`, 'i') : new RegExp(escapeRe(name));
      const m = re.exec(text);
      if (m && (!best || m.index < best.idx)) best = { idx: m.index, entry };
    }
  }
  if (!best) return null;
  const [ko, en, extra] = best.entry;
  return { city: ko, aliases: [ko, en, ...extra.filter((a) => /^[A-Za-z .]+$/.test(a))] };
}

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const validDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const addDays = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const nightsBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/** Build [checkIn, checkOut) from month/day parts relative to `today` (past dates roll to next year). */
function rangeFrom(today: string, m1: number, d1: number, m2: number | null, d2: number, y1?: number, y2?: number) {
  const ty = Number(today.slice(0, 4));
  let y = y1 ?? ty;
  if (!validDate(y, m1, d1)) return null;
  if (!y1 && iso(y, m1, d1) < today) y += 1;
  let em = m2 ?? m1;
  let ey = y2 ?? y;
  if (!m2 && d2 <= d1) em = m1 + 1; // "30일~2일" crosses a month
  if (em > 12) {
    em = 1;
    ey += 1;
  } else if (!y2 && em < m1) ey = y + 1;
  if (!validDate(ey, em, d2)) return null;
  const checkIn = iso(y, m1, d1);
  const checkOut = iso(ey, em, d2);
  if (checkOut <= checkIn || nightsBetween(checkIn, checkOut) > 90) return null;
  return { checkIn, checkOut };
}

export function parseDates(text: string, today: string): { checkIn: string; checkOut: string } | { checkIn: string; checkOut: null } | null {
  let m: RegExpExecArray | null;
  const sep = '\\s*(?:~|〜|-|–|—|부터|에서|to|until|till|through)\\s*';
  // 2026-11-03 ~ 2026-11-07 | 2026.11.3~11.7
  if ((m = new RegExp(`(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})${sep}(?:(\\d{4})[-./])?(?:(\\d{1,2})[-./])?(\\d{1,2})`).exec(text))) {
    const r = rangeFrom(today, +m[2], +m[3], m[5] ? +m[5] : null, +m[6], +m[1], m[4] ? +m[4] : undefined);
    if (r) return r;
  }
  // 11월 3일~7일 | 11월 3일부터 11월 7일까지 | 11월 3~7일 | 12월 30일 ~ 1월 2일
  if ((m = new RegExp(`(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일?${sep}(?:(\\d{1,2})\\s*월\\s*)?(\\d{1,2})\\s*일`).exec(text))) {
    const r = rangeFrom(today, +m[1], +m[2], m[3] ? +m[3] : null, +m[4]);
    if (r) return r;
  }
  // 11/3-11/7 | 11/3~7
  if ((m = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})${sep}(?:(\\d{1,2})/)?(\\d{1,2})\\b`).exec(text))) {
    const r = rangeFrom(today, +m[1], +m[2], m[3] ? +m[3] : null, +m[4]);
    if (r) return r;
  }
  // Nov 3-7 | November 3 to November 7 | Nov 3rd - Dec 2nd
  const mon = `(${MONTHS_EN.join('|')})[a-z]*\\.?`;
  if ((m = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?${sep}(?:${mon}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(text))) {
    const m1 = MONTHS_EN.indexOf(m[1].toLowerCase()) + 1;
    const m2 = m[3] ? MONTHS_EN.indexOf(m[3].toLowerCase()) + 1 : null;
    const r = rangeFrom(today, m1, +m[2], m2, +m[4]);
    if (r) return r;
  }
  // single start date: "11월 3일" / "Nov 3" (checkout from nights if given)
  if ((m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text)) || (m = new RegExp(`\\b${mon}\\s+(\\d{1,2})\\b`, 'i').exec(text))) {
    const mm = /^\d+$/.test(m[1]) ? +m[1] : MONTHS_EN.indexOf(m[1].toLowerCase()) + 1;
    const d = +m[2];
    let y = Number(today.slice(0, 4));
    if (validDate(y, mm, d)) {
      if (iso(y, mm, d) < today) y += 1;
      return { checkIn: iso(y, mm, d), checkOut: null };
    }
  }
  // this/next weekend: Saturday → Monday
  const wk = /(다음\s*주\s*말|next weekend)/i.test(text) ? 7 : /(이번\s*주\s*말|주말|this weekend|weekend)/i.test(text) ? 0 : null;
  if (wk !== null) {
    const t = new Date(`${today}T00:00:00Z`);
    const toSat = (6 - t.getUTCDay() + 7) % 7;
    const sat = addDays(today, toSat + wk);
    return { checkIn: sat, checkOut: addDays(sat, 2) };
  }
  return null;
}

export function parseNights(text: string): number | null {
  const m = /(\d{1,2})\s*박/.exec(text) ?? /(\d{1,2})\s*nights?\b/i.exec(text);
  const n = m ? +m[1] : null;
  return n && n >= 1 && n <= 90 ? n : null;
}

export function parseGuests(text: string): number | null {
  let total = 0;
  const re = /(\d{1,2})\s*(?:명|인(?!당)|people|persons|guests|adults|kids|children|pax)\b?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // "1인당" (per person) is a budget qualifier, not a head count
    if (/당/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 1))) continue;
    total += +m[1];
  }
  if (total > 0) return Math.min(total, 50);
  if (/(혼자|나홀로|solo|alone|by myself)/i.test(text)) return 1;
  if (/(둘이|커플|부부|연인|couple|two of us)/i.test(text)) return 2;
  return null;
}

export function parseBudget(text: string): TravelIntent['budget'] {
  let amount: number | null = null;
  let currency: 'KRW' | 'USD' = 'KRW';
  let m: RegExpExecArray | null;
  if ((m = /(\d+(?:\.\d+)?)\s*만\s*원?/.exec(text))) amount = Math.round(Number(m[1]) * 10000);
  else if ((m = /(\d+(?:\.\d+)?)\s*천\s*원/.exec(text))) amount = Math.round(Number(m[1]) * 1000);
  else if ((m = /₩\s*(\d[\d,]*)/.exec(text)) || (m = /(\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:원|won|krw)\b?/i.exec(text))) amount = Number(m[1].replace(/,/g, ''));
  else if ((m = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/.exec(text)) || (m = /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b/i.exec(text))) {
    currency = 'USD';
    amount = Math.round(Number(m[1].replace(/,/g, '')) * 100);
  }
  if (!amount || amount <= 0) return null;
  const window = text.slice(Math.max(0, (m?.index ?? 0) - 12), (m?.index ?? 0) + (m?.[0].length ?? 0) + 12);
  const per = /(1\s*박|박당|하룻밤|per night|a night|\/\s*night|nightly)/i.test(window)
    ? 'NIGHT'
    : /(1\s*인당|인당|per person|each|pp\b)/i.test(window)
      ? 'PERSON'
      : 'TOTAL';
  return { amountMinor: amount, currency, per };
}

const INTEREST_WORDS: Record<Interest, RegExp> = {
  beach: /(바다|해변|해수욕|바닷가|beach|ocean|seaside|\bsea\b)/i,
  food: /(맛집|음식|먹방|미식|먹거리|food|restaurant|eat|cuisine)/i,
  cafe: /(카페|커피|cafe|café|coffee)/i,
  hiking: /(등산|하이킹|트레킹|오름|올레|hiking|trek)/i,
  nature: /(자연|숲|산책|nature|forest|park)/i,
  history: /(역사|유적|문화재|고궁|궁궐|history|heritage|palace|temple|사찰)/i,
  shopping: /(쇼핑|시장|shopping|market)/i,
  art: /(미술관|박물관|전시|갤러리|art|museum|gallery|exhibition)/i,
  nightlife: /(야경|술집|bar\b|pub|nightlife|night view)/i,
  spa: /(온천|스파|찜질|spa|hot spring|onsen)/i,
  photo: /(사진|인스타|포토|photo|instagram)/i,
  family: /(아이|어린이|가족|아기|kids|children|family|child)/i,
  hanok: /(한옥|hanok)/i,
  kculture: /(k-?pop|케이팝|아이돌|드라마|k-?drama|kculture)/i,
};

export function parseInterests(text: string): Interest[] {
  return INTERESTS.filter((i) => INTEREST_WORDS[i].test(text));
}

export function parseModes(text: string): Mode[] {
  const modes: Mode[] = [];
  if (/(숙소|숙박|머물|묵을|펜션|호텔|민박|게스트하우스|에어비앤비|한옥\s*스테이|stay|accommodation|place to stay|airbnb|room|lodging|hotel)/i.test(text)) modes.push('stay');
  if (/(교환|홈\s*익스체인지|집\s*바꾸|home\s*exchange|house\s*swap|swap)/i.test(text)) modes.push('exchange');
  if (/(가이드|현지인|동행|안내해|길잡이|guide|local friend|show me around)/i.test(text)) modes.push('guide');
  if (/(투어|티켓|액티비티|패키지|체험|입장권|tour|ticket|activit|package|experience)/i.test(text)) modes.push('travel');
  return modes.length ? modes : ['stay', 'guide', 'travel'];
}

export function parseIntentRuleBased(text: string, today: string): TravelIntent {
  const t = text.normalize('NFKC').slice(0, 2000);
  const dates = parseDates(t, today);
  const nights = parseNights(t);
  let checkIn = dates?.checkIn ?? null;
  let checkOut = dates?.checkOut ?? null;
  if (checkIn && !checkOut && nights) checkOut = addDays(checkIn, nights);
  const intent: TravelIntent = {
    destination: resolveCity(t),
    checkIn,
    checkOut,
    nights: checkIn && checkOut ? nightsBetween(checkIn, checkOut) : nights,
    guests: parseGuests(t),
    budget: parseBudget(t),
    interests: parseInterests(t),
    modes: parseModes(t),
    language: /[가-힣]/.test(t) ? 'ko' : 'en',
  };
  return travelIntentSchema.parse(intent);
}
