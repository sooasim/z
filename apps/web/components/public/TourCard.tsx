'use client';
import { useI18n } from '@/lib/i18n';
import { f } from '@/lib/shape';
import { productView } from '@/lib/domain';
import { postcardSet } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { HeartButton } from '@/components/favorites';
import { realImages } from '@/components/cards';
import { ListingCard, type CardBadge } from '@/components/ui';
import { productKindLabel, refundLines } from './labels';

/**
 * Travel product card on the kit ListingCard: "제주 · 4시간 · WONT Travel Club Tours 제공", "₩45,000~" and a
 * "무료 취소" badge derived from the structured refund terms (not only the free-text note).
 * TODO(shared): mirror this copy in components/cards.tsx ProductCard.
 */
export function TourCard({ p }: { p: any }) {
  const v = productView(p);
  const { L, lang } = useI18n();
  const real = realImages([v.cover]);
  const hours = v.durationMinutes && !v.durationDays ? Math.round((v.durationMinutes / 60) * 10) / 10 : undefined;
  const refund = refundLines(f(p, 'cancellationTerms'), 'ko');
  const freeCancel = refund.some((l) => l.includes('전액 환불')) || /free|무료/i.test(v.cancellation);
  const badges: CardBadge[] = [{ label: productKindLabel(v.kind, lang), tone: 'info' }];
  if (freeCancel) badges.push({ label: L('무료 취소', 'Free cancellation'), tone: 'ok' });
  return (
    <ListingCard
      href={`/travel/${v.id}`}
      images={real.length ? real : postcardSet(v.city || v.title, v.id, 2)}
      title={v.title}
      meta={[placeLabel(v.city, lang), v.durationDays ? L(`${v.durationDays}일`, `${v.durationDays} days`) : hours ? L(`${hours}시간`, `${hours} h`) : '', v.supplier && L(`${v.supplier} 제공`, `by ${v.supplier}`)].filter(Boolean).join(' · ')}
      priceMinor={v.priceMinor}
      currency={v.currency}
      priceSuffix={L('~ / 1인', '+ / person')}
      badges={badges}
      fav={v.id ? <HeartButton targetType="TRAVEL_PRODUCT" targetId={v.id} /> : undefined}
    />
  );
}
