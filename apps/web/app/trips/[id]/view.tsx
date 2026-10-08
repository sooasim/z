'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, f, item, items, num, str } from '@/lib/shape';
import { formatDate, formatRange, parseDateRange } from '@/lib/format';
import { quoteView } from '@/lib/quote';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { QuoteBreakdown } from '@/components/quote';
import { MapView } from '@/components/map';
import { realImages } from '@/components/cards';
import { Alert, Avatar, ButtonLink, Icon, Kv, Money, PageHeader, Section, StatusPill, Timeline } from '@/components/ui';
import { CalendarButton, CopyButton, InfoCard, styles as s } from '@/components/traveler/ui';
import { useCachedApi, useConversationFor, useProperties } from '@/components/traveler/hooks';
import { dayLabel, daysUntil, formatAddress, hhmm, paymentMethodLabel, policyName, policySentences, reservationMilestones } from '@/components/traveler/labels';

export function reservationRange(r: any) {
  const dr = parseDateRange(r?.during ?? r?.stay_range ?? r?.range);
  return { start: dr?.start ?? str(r, 'checkIn', 'startDate'), end: dr?.end ?? str(r, 'checkOut', 'endDate') };
}

function HouseRules({ rules }: { rules: any }) {
  const { L } = useI18n();
  if (!rules) return null;
  const items: Array<[string, string]> = [];
  if (f(rules, 'smokingAllowed') === false) items.push(['ban', L('실내 금연', 'No smoking')]);
  if (f(rules, 'petsAllowed') === false) items.push(['paw', L('반려동물 동반 불가', 'No pets')]);
  else if (f(rules, 'petsAllowed') === true) items.push(['paw', L('반려동물 동반 가능', 'Pets allowed')]);
  if (f(rules, 'eventsAllowed') === false) items.push(['users', L('파티·행사 불가', 'No parties or events')]);
  const quiet = str(rules, 'quietHours');
  if (quiet) items.push(['moon', L(`조용한 시간 ${quiet.replace('-', '–')}`, `Quiet hours ${quiet.replace('-', '–')}`)]);
  const extra = str(rules, 'extraRules');
  if (!items.length && !extra) return null;
  return (
    <InfoCard title={L('숙소 이용 규칙', 'House rules')} icon="doc">
      <ul className="amenity-list">
        {items.map(([icon, text]) => (
          <li key={text}>
            <Icon name={icon} size={18} /> {text}
          </li>
        ))}
      </ul>
      {extra && <p className="small muted" style={{ margin: 0 }}>{extra}</p>}
    </InfoCard>
  );
}

function Detail({ r }: { r: any }) {
  const { L, lang } = useI18n();
  const id = str(r, 'id');
  const { start, end } = reservationRange(r);
  const status = str(r, 'status', 'state').toUpperCase();
  const pid = str(r, 'propertyId', 'property.id');
  const props = useProperties([pid]);
  const p = props[pid];
  const title = str(r, 'property.title', 'propertyTitle') || str(p, 'title') || L('숙소 예약', 'Stay');
  const city = str(r, 'property.city') || str(p, 'location.city', 'city');
  const conv = useConversationFor('RESERVATION', id, str(r, 'conversationId'));
  const pays = useCachedApi<any>('/v1/payments?limit=100');
  const payment = items(pays.data).find((x) => str(x, 'subjectId') === id && ['APPROVED', 'DONE', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(str(x, 'status').toUpperCase()));
  const policy = f<any>(r, 'cancellationPolicy') ?? f<any>(p, 'cancellationPolicy');
  const checkInTime = hhmm(str(policy, 'checkInTime')) || hhmm(str(p, 'checkInTime'));
  const checkOutTime = hhmm(str(p, 'checkOutTime'));
  const addr = formatAddress(f(r, 'property.address') ?? f(r, 'address', 'exactAddress'), lang);
  const media = realImages((Array.isArray(p?.media) ? p.media : []).map((m: any) => str(m, 'url')));
  const cover = media[0] || postcardFor(city || title, pid || id);
  const guests = num(r, 'guests', 'guestCount');
  const active = ['CONFIRMED', 'CHECKED_IN'].includes(status);
  const pending = ['HELD', 'PAYMENT_PENDING', 'QUOTED', 'DRAFT'].includes(status);
  const dd = daysUntil(start);
  const milestones = reservationMilestones(arr(r, 'history', 'transitions', 'stateHistory'), lang).reverse();
  const nextStep =
    status === 'CONFIRMED'
      ? L(`다음 단계: 체크인 · ${dayLabel(start, lang)}${checkInTime ? ` ${checkInTime}부터` : ''}`, `Next: check-in · ${dayLabel(start, lang)}${checkInTime ? ` from ${checkInTime}` : ''}`)
      : status === 'CHECKED_IN'
        ? L(`다음 단계: 체크아웃 · ${dayLabel(end, lang)}${checkOutTime ? ` ${checkOutTime}까지` : ''}`, `Next: check-out · ${dayLabel(end, lang)}${checkOutTime ? ` by ${checkOutTime}` : ''}`)
        : pending
          ? L('다음 단계: 결제를 완료하면 예약이 확정돼요', 'Next: complete payment to confirm')
          : '';
  const lat = num(p, 'location.lat', 'lat');
  const lng = num(p, 'location.lng', 'lng');
  const host = f<any>(p, 'host');
  const sentences = policySentences(policy, lang);
  const cur = str(r, 'currency') || 'KRW';
  const q = f<any>(r, 'quote');
  const msgHref = conv ? `/messages?c=${str(conv, 'id')}` : `/messages`;
  return (
    <>
      <PageHeader
        title={title}
        subtitle={[placeLabel(city, lang), start && end ? formatRange(start, end, lang, { nights: true }) : '', guests ? L(`게스트 ${guests}명`, `${guests} guest${guests > 1 ? 's' : ''}`) : ''].filter(Boolean).join(' · ')}
        back="/trips"
        actions={<StatusPill status={status} />}
      />
      <div className="stack-lg">
        {pending && (
          <Alert tone="warn">
            <div className="row between" style={{ gap: 12 }}>
              <span>{L('아직 결제가 완료되지 않았어요. 결제가 승인되어야 예약이 확정됩니다.', 'Payment is not complete yet. The booking is confirmed once payment is approved.')}</span>
              <ButtonLink size="sm" variant="accent" href={`/checkout?type=RESERVATION&id=${id}`}>{L('결제 계속하기', 'Continue payment')}</ButtonLink>
            </div>
          </Alert>
        )}
        {['CANCELLED', 'CANCELED'].includes(status) && (
          <Alert tone="info">
            {L('취소된 예약이에요.', 'This booking was cancelled.')} {num(r, 'refundedMinor') ? <>{L('환불 금액', 'Refunded')} <strong><Money minor={num(r, 'refundedMinor')} currency={cur} /></strong> · {L('카드사에 따라 3~7영업일이 걸릴 수 있어요.', 'Card refunds take 3–7 business days.')}</> : null}
          </Alert>
        )}
        <div className={s.hero}>
          <Photo src={cover} alt={L(`${title} 대표 사진`, `${title} cover photo`)} sizes="(max-width: 900px) 100vw, 800px" />
          {active && dd >= 0 && (
            <div className={s.heroBadge}>
              <span className="badge solid">{dd === 0 ? L('오늘 체크인', 'Check-in today') : L(`체크인까지 ${dd}일`, `${dd} days to check-in`)}</span>
            </div>
          )}
        </div>
        <div className={s.toolbar} role="group" aria-label={L('예약 작업', 'Booking actions')}>
          <ButtonLink variant="primary" icon="chat" href={msgHref} className={s.wide}>
            {L('호스트에게 메시지', 'Message host')}
          </ButtonLink>
          <ButtonLink icon="settings" href={`/trips/${id}/manage`}>{L('예약 관리', 'Manage')}</ButtonLink>
          <ButtonLink icon="doc" href="/payments">{L('영수증', 'Receipt')}</ButtonLink>
          {active && start && end && (
            <CalendarButton
              filename={`jetpool-${str(r, 'code') || id.slice(0, 8)}.ics`}
              event={{ uid: id, title: `${title} · JETPOOL`, start, end, location: addr?.oneLine, description: [L(`예약 번호 ${str(r, 'code')}`, `Booking ${str(r, 'code')}`), checkInTime && L(`체크인 ${checkInTime} 이후`, `Check-in after ${checkInTime}`), checkOutTime && L(`체크아웃 ${checkOutTime}까지`, `Check-out by ${checkOutTime}`)].filter(Boolean).join('\n'), url: typeof window !== 'undefined' ? `${window.location.origin}/trips/${id}` : undefined }}
            />
          )}
          <ButtonLink variant="ghost" icon="flag" href={`/support/disputes?subjectType=RESERVATION&subjectId=${id}`}>{L('문제 신고', 'Report a problem')}</ButtonLink>
        </div>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stack-lg">
            <InfoCard title={L('체크인 · 체크아웃', 'Check-in & check-out')} icon="key">
              <div className={s.dates}>
                <div>
                  <span className={s.k}>{L('체크인', 'Check-in')}</span>
                  <span className={s.v}>{start ? dayLabel(start, lang) : '—'}</span>
                  <span className={s.t}>{checkInTime ? L(`${checkInTime} 이후`, `After ${checkInTime}`) : L('시간은 호스트와 조율', 'Time with host')}</span>
                </div>
                <div>
                  <span className={s.k}>{L('체크아웃', 'Check-out')}</span>
                  <span className={s.v}>{end ? dayLabel(end, lang) : '—'}</span>
                  <span className={s.t}>{checkOutTime ? L(`${checkOutTime}까지`, `By ${checkOutTime}`) : L('시간은 호스트와 조율', 'Time with host')}</span>
                </div>
              </div>
              <div className={s.iconRow}>
                <Icon name="info" size={20} />
                <p className="small" style={{ margin: 0 }}>
                  {str(r, 'checkInInstructions') ||
                    (active
                      ? L('출입 방법·주차·와이파이 등 체크인 안내는 호스트가 메시지로 보내드려요. 궁금한 점은 미리 물어보세요.', 'Your host will message you entry, parking and Wi-Fi details. Ask anything ahead of time.')
                      : L('체크인 안내는 예약이 확정된 뒤 제공돼요.', 'Check-in details are shared once the booking is confirmed.'))}
                </p>
              </div>
            </InfoCard>
            <InfoCard
              title={L('주소 · 찾아가는 길', 'Address & directions')}
              icon="pin"
              actions={addr ? <CopyButton text={addr.oneLine} label={L('주소 복사', 'Copy address')} copied={L('주소를 복사했어요', 'Address copied')} /> : undefined}
            >
              {addr ? (
                <div className="stack" style={{ margin: 0 }}>
                  <div>
                    <strong style={{ fontSize: 'var(--fs-lg)' }}>{addr.street}</strong>
                    {addr.detail && <div className="small muted">{addr.detail}</div>}
                    {addr.locality && <div className="small muted">{addr.locality}</div>}
                  </div>
                  {lat !== undefined && lng !== undefined && (
                    <div className={s.mapBox}>
                      <MapView points={[{ id: pid || id, lat, lng, label: L('숙소', 'Stay'), title }]} center={[lng, lat]} zoom={14} height={220} />
                    </div>
                  )}
                  <div className="row" style={{ gap: 8 }}>
                    <a className="btn sm" href={`https://map.kakao.com/link/search/${encodeURIComponent(addr.street)}`} target="_blank" rel="noopener noreferrer">
                      <Icon name="external" size={16} /> {L('카카오맵', 'Kakao Map')}
                    </a>
                    <a className="btn sm" href={`https://map.naver.com/p/search/${encodeURIComponent(addr.street)}`} target="_blank" rel="noopener noreferrer">
                      <Icon name="external" size={16} /> {L('네이버 지도', 'Naver Map')}
                    </a>
                  </div>
                  {lat !== undefined && <p className="xs muted" style={{ margin: 0 }}>{L('지도의 핀은 대략적인 위치예요. 정확한 위치는 위 주소를 기준으로 찾아가세요.', 'The pin is approximate; use the address above for directions.')}</p>}
                </div>
              ) : (
                <p className="muted small" style={{ margin: 0 }}>
                  <Icon name="lock" size={16} style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }} />
                  {L('정확한 주소는 예약이 확정되면 공개돼요.', 'The exact address is shown once the booking is confirmed.')}
                </p>
              )}
            </InfoCard>
            <HouseRules rules={f(p, 'houseRules')} />
            <InfoCard title={L('취소·환불 정책', 'Cancellation policy')} icon="shield" actions={active ? <Link href={`/trips/${id}/manage`} className="small">{L('예상 환불액 보기', 'See refund estimate')}</Link> : undefined}>
              {policy ? (
                <>
                  <p style={{ margin: 0 }}>
                    <span className="badge info">{policyName(policy, lang)}</span>
                  </p>
                  {sentences.length > 0 && (
                    <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                      {sentences.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  )}
                  {f(policy, 'service_fee_refundable', 'serviceFeeRefundable') === false && <p className="xs muted" style={{ margin: 0 }}>{L('서비스 수수료는 환불되지 않아요.', 'The service fee is non-refundable.')}</p>}
                </>
              ) : (
                <p className="muted small" style={{ margin: 0 }}>{L('정책 정보를 불러오지 못했어요. 예약 관리에서 예상 환불액을 확인하세요.', 'Policy unavailable. Check the refund estimate under Manage.')}</p>
              )}
            </InfoCard>
            {milestones.length > 0 && (
              <Section title={L('예약 진행 상황', 'Booking progress')}>
                {nextStep && (
                  <p className="small" style={{ margin: 0, fontWeight: 600 }}>
                    <Icon name="clock" size={16} style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }} />
                    {nextStep}
                  </p>
                )}
                <Timeline events={milestones.map((m) => ({ title: m.title, at: m.at, note: m.note }))} />
              </Section>
            )}
          </div>
          <aside className={s.aside} aria-label={L('결제 정보', 'Payment')}>
            <section className="card stack">
              <h2 style={{ fontSize: 'var(--fs-lg)', margin: 0 }}>{L('결제 정보', 'Payment')}</h2>
              {q ? <QuoteBreakdown q={{ ...quoteView(q), expiresAt: '' }} /> : <p className="row between" style={{ margin: 0 }}><span className="muted">{L('총액', 'Total')}</span><strong><Money minor={num(r, 'totalMinor', 'amountMinor')} currency={cur} /></strong></p>}
              {num(r, 'refundedMinor') ? (
                <p className="row between small" style={{ margin: 0 }}>
                  <span className="muted">{L('환불된 금액', 'Refunded')}</span>
                  <strong style={{ color: 'var(--success)' }}>−<Money minor={num(r, 'refundedMinor')} currency={cur} /></strong>
                </p>
              ) : null}
              <div className={s.kvTight}>
                <Kv
                  rows={[
                    [L('예약 번호', 'Booking code'), <span className="mono" key="c">{str(r, 'code') || id.slice(0, 8)}</span>],
                    [L('결제 수단', 'Paid with'), payment ? paymentMethodLabel(str(payment, 'method') || str(payment, 'provider'), lang) : '—'],
                    [L('결제일', 'Paid on'), payment ? formatDate(str(payment, 'approvedAt', 'createdAt'), lang) : '—'],
                  ]}
                />
              </div>
              <ButtonLink size="sm" href="/payments" iconRight="right">{L('영수증·환불 내역', 'Receipts & refunds')}</ButtonLink>
            </section>
            {host && (
              <section className="card stack">
                <div className="row nowrap" style={{ gap: 12 }}>
                  <Avatar name={str(host, 'displayName')} size={48} verified={!!f(host, 'identityVerified', 'verified')} />
                  <div className="grow">
                    <div className="xs muted">{L('호스트', 'Host')}</div>
                    <strong>{str(host, 'displayName')}</strong>
                  </div>
                </div>
                {num(host, 'responseRate') !== undefined && <p className="xs muted" style={{ margin: 0 }}>{L(`응답률 ${num(host, 'responseRate')}%`, `Response rate ${num(host, 'responseRate')}%`)}</p>}
                <ButtonLink href={msgHref} icon="chat" block>{L('메시지 보내기', 'Send a message')}</ButtonLink>
                {str(p, 'slug') && <Link className="small" href={`/stay/${str(p, 'slug')}`}>{L('숙소 페이지 보기', 'View listing')}</Link>}
              </section>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

export default function TripDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const st = useApi<any>(`/v1/reservations/${id}`, { auth: true });
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail" back={{ href: '/trips', label: L('내 여행으로', 'Back to trips') }}>
        {(d) => <Detail r={item(d)} />}
      </StateView>
    </RequireAuth>
  );
}
