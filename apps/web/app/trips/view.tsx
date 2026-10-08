'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { f, items, num, str } from '@/lib/shape';
import { formatDate, formatMoney, formatRange, formatTimeRange, parseDateRange } from '@/lib/format';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { ButtonLink, Icon, PageHeader, Tabs, tabPanelProps } from '@/components/ui';
import { realImages } from '@/components/cards';
import { TripCard, TripGroup, styles as s } from '@/components/traveler/ui';
import { useCachedMany, useConversations, useGuides, useOrderDepartures, useProperties } from '@/components/traveler/hooks';
import { ORDER_STATUS_LABELS, daysUntil, exchangeNext, todayIso } from '@/components/traveler/labels';

type Tab = 'stays' | 'exchanges' | 'guides' | 'orders';
const TABS: Tab[] = ['stays', 'exchanges', 'guides', 'orders'];
const ALIAS: Record<string, Tab> = { stay: 'stays', reservation: 'stays', reservations: 'stays', exchange: 'exchanges', guide: 'guides', 'guide-bookings': 'guides', order: 'orders', travel: 'orders', tours: 'orders' };

/** Whitelisted tab from the URL (aliases map to their canonical value; anything else falls back to stays). */
export function tripsTab(v: string | null): Tab {
  const k = (v ?? '').toLowerCase();
  if ((TABS as string[]).includes(k)) return k as Tab;
  return ALIAS[k] ?? 'stays';
}

const CANCELLED = ['CANCELLED', 'CANCELED', 'EXPIRED', 'DECLINED', 'WITHDRAWN', 'NO_SHOW', 'REFUNDED', 'FAILED'];
const coverOf = (p: any, city: string, seed: string) => {
  const media = (Array.isArray(p?.media) ? p.media : []).map((m: any) => str(m, 'url')).concat([str(p, 'coverUrl')]);
  return realImages(media)[0] || postcardFor(city, seed);
};

function Groups({ upcoming, past, cancelled }: { upcoming: ReactNode[]; past: ReactNode[]; cancelled: ReactNode[] }) {
  const { L } = useI18n();
  return (
    <>
      <TripGroup title={L('다가오는 여행', 'Upcoming')} count={upcoming.length}>
        {upcoming}
      </TripGroup>
      <TripGroup title={L('지난 여행', 'Past')} count={past.length}>
        {past}
      </TripGroup>
      <TripGroup title={L('취소·만료', 'Cancelled & expired')} count={cancelled.length}>
        {cancelled}
      </TripGroup>
    </>
  );
}

function Empty({ tab }: { tab: Tab }) {
  const { L } = useI18n();
  const copy: Record<Tab, { t: string; b: string; cta: string; href: string }> = {
    stays: { t: L('아직 예약한 숙소가 없어요', 'No stays booked yet'), b: L('한달살기부터 주말 여행까지, 인허가를 확인한 숙소를 둘러보세요.', 'Browse verified stays for a weekend or a month.'), cta: L('숙소 찾기', 'Find a stay'), href: '/stay' },
    exchanges: { t: L('진행 중인 홈 맞교환이 없어요', 'No home exchanges yet'), b: L('내 집과 서로 바꿔 머물 집을 찾아보세요. 숙박비 없이 현지처럼 살아볼 수 있어요.', 'Swap homes and live like a local without paying for a stay.'), cta: L('맞교환 둘러보기', 'Explore exchanges'), href: '/exchange' },
    guides: { t: L('가이드 일정이 없어요', 'No guide sessions yet'), b: L('동네를 잘 아는 가이드 프렌드와 함께 걸어 보세요.', 'Walk the neighborhood with a local guide friend.'), cta: L('가이드 찾기', 'Find a guide'), href: '/guide-friends' },
    orders: { t: L('주문한 여행 상품이 없어요', 'No travel orders yet'), b: L('투어·티켓·패키지를 둘러보고 일정에 더해 보세요.', 'Add tours, tickets or packages to your trip.'), cta: L('여행 상품 보기', 'Browse travel'), href: '/travel' },
  };
  const c = copy[tab];
  return (
    <EmptyState illo="trips" title={c.t} action={<ButtonLink variant="primary" href={c.href} iconRight="right">{c.cta}</ButtonLink>}>
      {c.b}
    </EmptyState>
  );
}

function StaysTab() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/reservations', { auth: true, query: { limit: 100 } });
  const reviews = useApi<any>('/v1/me/reviews', { auth: true });
  const rows = items(st.data);
  const props = useProperties(rows.map((r) => str(r, 'propertyId')));
  const convs = useConversations();
  const pendingReview = new Map<string, string>(((reviews.data?.pending ?? []) as any[]).map((p) => [str(p, 'transactionId', 'transaction_id'), str(p, 'targetType', 'target_type')]));
  const today = todayIso();
  return (
    <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<Empty tab="stays" />}>
      {() => {
        const card = (r: any) => {
          const id = str(r, 'id');
          const status = str(r, 'status', 'state').toUpperCase();
          const dr = parseDateRange(r.during ?? r.stay_range);
          const ci = dr?.start ?? str(r, 'checkIn');
          const co = dr?.end ?? str(r, 'checkOut');
          const p = props[str(r, 'propertyId')] ?? f(r, 'property');
          const city = str(p, 'location.city', 'city');
          const title = str(p, 'title') || str(r, 'propertyTitle', 'property.title') || `${L('숙소 예약', 'Stay')} ${str(r, 'code')}`;
          const conv = convs.find((c) => str(c, 'contextType') === 'RESERVATION' && str(c, 'contextId') === id);
          const d = daysUntil(ci);
          let next: { label: string; href: string; tone?: 'primary' | 'accent' } | undefined;
          if (['HELD', 'PAYMENT_PENDING', 'QUOTED', 'DRAFT'].includes(status)) next = { label: L('결제 완료하기', 'Complete payment'), href: `/checkout?type=RESERVATION&id=${id}`, tone: 'accent' };
          else if (status === 'CONFIRMED' || status === 'CHECKED_IN') next = conv ? { label: L('호스트에게 메시지', 'Message host'), href: `/messages?c=${str(conv, 'id')}` } : { label: L('예약 상세', 'Details'), href: `/trips/${id}` };
          else if (status === 'COMPLETED' && pendingReview.has(id)) next = { label: L('후기 남기기', 'Write a review'), href: `/reviews?subjectType=RESERVATION&subjectId=${id}&targetType=${pendingReview.get(id) || 'PROPERTY'}`, tone: 'primary' };
          else if (status === 'COMPLETED' && str(p, 'slug')) next = { label: L('다시 예약하기', 'Book again'), href: `/stay/${str(p, 'slug')}` };
          const badge =
            status === 'CONFIRMED' && d >= 0 ? <span className={s.dday}>{d === 0 ? L('오늘 체크인', 'Check-in today') : `D-${d}`}</span> : status === 'CHECKED_IN' ? <span className={s.dday}>{L('이용 중', 'Staying now')}</span> : undefined;
          return (
            <TripCard
              key={id}
              href={`/trips/${id}`}
              image={coverOf(p, city, id)}
              title={title}
              meta={[
                <><Icon name="calendar" size={14} /> {ci && co ? formatRange(ci, co, lang, { nights: true }) : '—'}</>,
                city ? <><Icon name="pin" size={14} /> {placeLabel(city, lang)}</> : null,
                num(r, 'guests') ? `${L('게스트', 'Guests')} ${num(r, 'guests')}${L('명', '')}` : null,
              ]}
              status={status}
              badge={badge}
              code={str(r, 'code')}
              next={next}
              dimmed={CANCELLED.includes(status)}
            />
          );
        };
        const isCancelled = (r: any) => CANCELLED.includes(str(r, 'status').toUpperCase());
        const isPast = (r: any) => !isCancelled(r) && (str(r, 'status').toUpperCase() === 'COMPLETED' || str(r, 'checkOut') < today);
        const up = rows.filter((r) => !isCancelled(r) && !isPast(r)).sort((a, b) => str(a, 'checkIn').localeCompare(str(b, 'checkIn')));
        const past = rows.filter(isPast).sort((a, b) => str(b, 'checkOut').localeCompare(str(a, 'checkOut')));
        const cancelled = rows.filter(isCancelled);
        return <Groups upcoming={up.map(card)} past={past.map(card)} cancelled={cancelled.map(card)} />;
      }}
    </StateView>
  );
}

const MY_TURN = ['RESPOND', 'SAFETY_ACK', 'SIGN_AGREEMENT', 'CONFIRM', 'LEAVE_REVIEW', 'COMPLETE_AFTER_STAY'];
const NEXT_PATH: Record<string, string> = { SAFETY_ACK: '/verification', AWAIT_VERIFICATION: '/verification', SIGN_AGREEMENT: '/agreement', AWAIT_COUNTERPARTY_SIGNATURE: '/agreement', CONFIRM: '/agreement', PREPARE_TRIP: '/trip' };

function ExchangesTab() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/exchanges', { auth: true, query: { limit: 100 } });
  const rows = items(st.data);
  const theirs = (r: any) => (str(r, 'role') === 'RESPONDER' ? f<any>(r, 'propertyA') : f<any>(r, 'propertyB')) ?? {};
  const mine = (r: any) => (str(r, 'role') === 'RESPONDER' ? f<any>(r, 'propertyB') : f<any>(r, 'propertyA')) ?? {};
  const props = useProperties(rows.map((r) => str(theirs(r), 'id')));
  return (
    <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<Empty tab="exchanges" />}>
      {() => {
        const card = (r: any) => {
          const id = str(r, 'id');
          const status = str(r, 'status').toUpperCase();
          const t = theirs(r);
          const m = mine(r);
          const dates = str(r, 'role') === 'RESPONDER' ? f<any>(r, 'datesA') : f<any>(r, 'datesB');
          const city = str(t, 'city');
          const na = str(r, 'nextAction').toUpperCase();
          const nextLabel = exchangeNext(na, lang);
          return (
            <TripCard
              key={id}
              href={`/exchange/${id}`}
              image={coverOf(props[str(t, 'id')], city, id)}
              title={str(t, 'title') || L('홈 맞교환', 'Home exchange')}
              meta={[
                str(dates, 'start') ? <><Icon name="calendar" size={14} /> {formatRange(str(dates, 'start'), str(dates, 'end'), lang, { nights: true })}</> : null,
                city ? <><Icon name="pin" size={14} /> {placeLabel(city, lang)}</> : null,
                str(m, 'title') ? <><Icon name="swap" size={14} /> {L(`내 집: ${str(m, 'title')}`, `My home: ${str(m, 'title')}`)}</> : null,
              ]}
              status={status}
              badge={<span className="badge exchange"><Icon name="swap" size={13} /> {L('맞교환', 'Exchange')}</span>}
              next={nextLabel ? { label: nextLabel, href: `/exchange/${id}${NEXT_PATH[na] ?? ''}`, tone: MY_TURN.includes(na) ? 'accent' : undefined } : undefined}
              dimmed={CANCELLED.includes(status)}
            />
          );
        };
        const done = ['COMPLETED', 'REVIEWED'];
        const up = rows.filter((r) => !done.includes(str(r, 'status').toUpperCase()) && !CANCELLED.includes(str(r, 'status').toUpperCase()));
        const past = rows.filter((r) => done.includes(str(r, 'status').toUpperCase()));
        const cancelled = rows.filter((r) => CANCELLED.includes(str(r, 'status').toUpperCase()));
        return <Groups upcoming={up.map(card)} past={past.map(card)} cancelled={cancelled.map(card)} />;
      }}
    </StateView>
  );
}

const GUIDE_STATUS_LABELS: Record<string, [string, string]> = { REVIEWED: ['후기 작성 완료', 'Reviewed'], REQUESTED: ['제안 기다리는 중', 'Awaiting offers'], OFFERED: ['제안 도착', 'Offer received'], COUNTERED: ['조율 중', 'Negotiating'] };

function GuidesTab() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/guide-bookings', { auth: true, query: { role: 'traveler', limit: 100 } });
  const req = useApi<any>('/v1/guide-requests', { auth: true, query: { role: 'traveler', limit: 100 } });
  const bookings = items(st.data);
  const openReqs = items(req.data).filter((r) => ['REQUESTED', 'OFFERED', 'COUNTERED'].includes(str(r, 'status').toUpperCase()));
  const guides = useGuides([...bookings.map((b) => str(b, 'guideId', 'guide_id')), ...openReqs.map((r) => str(r, 'guideId', 'guide_id'))]);
  const combined = { ...st, data: st.data === undefined ? undefined : [...bookings, ...openReqs] };
  const now = new Date().toISOString();
  return (
    <StateView state={combined} isEmpty={(d) => (d as any[]).length === 0} empty={<Empty tab="guides" />}>
      {() => {
        const bookingCard = (b: any) => {
          const id = str(b, 'id');
          const status = str(b, 'status').toUpperCase();
          const g = guides[str(b, 'guideId', 'guide_id')];
          const name = str(g, 'displayName') || str(b, 'guideName');
          const city = str(g, 'city');
          const price = num(b, 'priceMinor', 'price_minor', 'amountMinor') ?? 0;
          const conv = str(b, 'conversationId', 'conversation_id');
          let next: { label: string; href: string; tone?: 'primary' | 'accent' } | undefined;
          if (status === 'PAYMENT_PENDING') next = { label: L('결제하기', 'Pay now'), href: `/checkout?type=GUIDE_BOOKING&id=${id}`, tone: 'accent' };
          else if (['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'].includes(status) && conv) next = { label: L('가이드에게 메시지', 'Message guide'), href: `/messages?c=${conv}` };
          else if (status === 'COMPLETED') next = { label: L('후기 남기기', 'Write a review'), href: `/reviews?targetType=GUIDE&targetId=${str(b, 'guideId', 'guide_id')}&subjectType=GUIDE_BOOKING&subjectId=${id}`, tone: 'primary' };
          return (
            <TripCard
              key={id}
              href={`/guide-bookings/${id}`}
              image={postcardFor(city || 'Seoul', id)}
              title={name ? L(`${name}님과의 가이드 일정`, `Session with ${name}`) : L('가이드 일정', 'Guide session')}
              meta={[
                <><Icon name="clock" size={14} /> {formatTimeRange(str(b, 'startAt', 'start_at', 'startsAt'), str(b, 'endAt', 'end_at', 'endsAt'), lang)}</>,
                city ? <><Icon name="pin" size={14} /> {placeLabel(city, lang)}</> : null,
                price > 0 ? formatMoney(price, str(b, 'currency') || 'KRW', lang) : L('무료 교류', 'Free meetup'),
              ]}
              status={status}
              statusLabels={GUIDE_STATUS_LABELS}
              next={next}
              dimmed={CANCELLED.includes(status)}
            />
          );
        };
        const requestCard = (r: any) => {
          const id = str(r, 'id');
          const status = str(r, 'status').toUpperCase();
          const g = guides[str(r, 'guideId', 'guide_id')];
          const city = str(r, 'city') || str(g, 'city');
          return (
            <TripCard
              key={id}
              href={`/guide-requests/${id}`}
              image={postcardFor(city || 'Seoul', id)}
              title={str(g, 'displayName') ? L(`${str(g, 'displayName')} 가이드에게 보낸 요청`, `Request to ${str(g, 'displayName')}`) : L(`${placeLabel(city, lang) || ''} 가이드 요청`.trim(), `Guide request${city ? ' · ' + city : ''}`)}
              meta={[<><Icon name="clock" size={14} /> {formatTimeRange(str(r, 'startAt', 'start_at'), str(r, 'endAt', 'end_at'), lang)}</>, num(r, 'partySize', 'party_size') ? `${num(r, 'partySize', 'party_size')}${L('명', ' people')}` : null]}
              status={status}
              statusLabels={GUIDE_STATUS_LABELS}
              next={status === 'OFFERED' || status === 'COUNTERED' ? { label: L('제안 확인하기', 'Review offer'), href: `/guide-requests/${id}`, tone: 'accent' } : undefined}
            />
          );
        };
        const cancelled = bookings.filter((b) => CANCELLED.includes(str(b, 'status').toUpperCase()));
        const past = bookings.filter((b) => !CANCELLED.includes(str(b, 'status').toUpperCase()) && (['COMPLETED', 'REVIEWED'].includes(str(b, 'status').toUpperCase()) || str(b, 'endAt', 'end_at') < now));
        const up = bookings.filter((b) => !cancelled.includes(b) && !past.includes(b)).sort((a, b) => str(a, 'start_at', 'startAt').localeCompare(str(b, 'start_at', 'startAt')));
        return <Groups upcoming={[...openReqs.map(requestCard), ...up.map(bookingCard)]} past={past.map(bookingCard)} cancelled={cancelled.map(bookingCard)} />;
      }}
    </StateView>
  );
}

function OrdersTab() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/orders', { auth: true, query: { limit: 100 } });
  const list = items(st.data);
  // The list payload has no line items: load each order (cached) for titles and departures.
  const details = useCachedMany(list.map((o) => `/v1/orders/${str(o, 'id')}`));
  const allLines = useMemo(() => Object.values(details).flatMap((o: any) => (Array.isArray(o?.items) ? o.items : [])), [details]);
  const deps = useOrderDepartures(allLines);
  return (
    <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<Empty tab="orders" />}>
      {() => {
        const card = (o0: any) => {
          const id = str(o0, 'id');
          const o = details[`/v1/orders/${id}`] ?? o0;
          const status = str(o, 'status').toUpperCase();
          const lines = Array.isArray(o.items) ? o.items : [];
          const first = lines[0];
          const dep = first ? deps[str(first, 'sellableId')] : undefined;
          const qty = lines.reduce((n: number, l: any) => n + (num(l, 'qty', 'quantity') ?? 1), 0);
          const title = first ? `${str(first, 'title')}${lines.length > 1 ? L(` 외 ${lines.length - 1}건`, ` +${lines.length - 1}`) : ''}` : `${L('주문', 'Order')} ${str(o, 'code')}`;
          let next: { label: string; href: string; tone?: 'primary' | 'accent' } | undefined;
          if (['PENDING', 'PAYMENT_PENDING', 'CREATED'].includes(status)) next = { label: L('결제하기', 'Pay now'), href: `/checkout?type=ORDER&id=${id}`, tone: 'accent' };
          else if (['PAID', 'CONFIRMED'].includes(status)) next = { label: L('바우처 보기', 'View vouchers'), href: `/orders/${id}#vouchers` };
          else if (['FULFILLED', 'COMPLETED'].includes(status) && dep?.productId) next = { label: L('후기 남기기', 'Write a review'), href: `/reviews?targetType=TRAVEL_PRODUCT&targetId=${dep.productId}&subjectType=ORDER&subjectId=${id}`, tone: 'primary' };
          return (
            <TripCard
              key={id}
              href={`/orders/${id}`}
              image={postcardFor(dep?.city || title, id)}
              title={title}
              meta={[
                dep?.startsAt ? <><Icon name="clock" size={14} /> {formatTimeRange(dep.startsAt, dep.endsAt, lang)}</> : <><Icon name="calendar" size={14} /> {L('주문일', 'Ordered')} {formatDate(str(o, 'createdAt'), lang)}</>,
                qty ? `${qty}${L('명', ' guests')}` : null,
                formatMoney(num(o, 'totalMinor') ?? 0, str(o, 'currency') || 'KRW', lang),
              ]}
              status={status}
              statusLabels={ORDER_STATUS_LABELS}
              code={str(o, 'code')}
              next={next}
              dimmed={CANCELLED.includes(status)}
            />
          );
        };
        const st0 = (o: any) => str(details[`/v1/orders/${str(o, 'id')}`] ?? o, 'status').toUpperCase();
        const past = list.filter((o) => ['FULFILLED', 'COMPLETED', 'REVIEWED'].includes(st0(o)));
        const cancelled = list.filter((o) => CANCELLED.includes(st0(o)));
        const up = list.filter((o) => !past.includes(o) && !cancelled.includes(o));
        return <Groups upcoming={up.map(card)} past={past.map(card)} cancelled={cancelled.map(card)} />;
      }}
    </StateView>
  );
}

export default function TripsView() {
  const { L } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const tab = tripsTab(sp.get('tab'));
  return (
    <RequireAuth>
      <PageHeader title={L('내 여행', 'My trips')} subtitle={L('숙소 예약, 홈 맞교환, 가이드 일정, 여행 상품을 한곳에서 확인하세요.', 'Stays, exchanges, guide sessions and tours in one place.')} />
      <Tabs
        idBase="trips"
        label={L('여행 유형', 'Trip type')}
        value={tab}
        onChange={(v) => router.replace(`/trips?tab=${v}`, { scroll: false })}
        tabs={[
          { value: 'stays', label: L('숙소 예약', 'Stays'), icon: 'home' },
          { value: 'exchanges', label: L('홈 맞교환', 'Exchanges'), icon: 'swap' },
          { value: 'guides', label: L('가이드', 'Guides'), icon: 'compass' },
          { value: 'orders', label: L('여행 상품', 'Travel orders'), icon: 'ticket' },
        ]}
      />
      <div {...tabPanelProps('trips', tab)} style={{ marginTop: 8 }}>
        {tab === 'stays' && <StaysTab />}
        {tab === 'exchanges' && <ExchangesTab />}
        {tab === 'guides' && <GuidesTab />}
        {tab === 'orders' && <OrdersTab />}
      </div>
    </RequireAuth>
  );
}
