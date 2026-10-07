'use client';
import { useI18n } from '@/lib/i18n';
import type { QuoteView } from '@/lib/quote';
import { DateText, PriceBreakdown } from './ui';

const LABELS: Record<string, { ko: string; en: string }> = {
  NIGHTLY: { ko: '숙박 요금', en: 'Nightly rate' },
  BASE: { ko: '숙박 요금', en: 'Nightly rate' },
  CLEANING: { ko: '청소비', en: 'Cleaning fee' },
  CLEANING_FEE: { ko: '청소비', en: 'Cleaning fee' },
  SERVICE_FEE: { ko: '서비스 수수료', en: 'Service fee' },
  GUEST_FEE: { ko: '서비스 수수료', en: 'Service fee' },
  TAX: { ko: '세금', en: 'Tax' },
  VAT: { ko: '부가세', en: 'VAT' },
  DISCOUNT: { ko: '할인', en: 'Discount' },
  PROMOTION: { ko: '프로모션', en: 'Promotion' },
};

export function QuoteBreakdown({ q }: { q: QuoteView }) {
  const { lang, L } = useI18n();
  return (
    <PriceBreakdown
      currency={q.currency}
      totalMinor={q.totalMinor}
      lines={q.lines.map((l) => ({ label: l.code?.toUpperCase() === 'NIGHTLY' && q.nights ? `${LABELS.NIGHTLY[lang]} · ${q.nights}${lang === 'ko' ? '박' : ' nights'}` : LABELS[l.code?.toUpperCase()]?.[lang] ?? l.label, amountMinor: l.amountMinor }))}
      footnote={q.expiresAt ? <>{L('견적 유효기간', 'Quote valid until')}: <DateText value={q.expiresAt} time /></> : undefined}
    />
  );
}
