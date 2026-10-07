'use client';
import { useI18n } from '@/lib/i18n';
import type { QuoteView } from '@/lib/quote';
import { Money, DateText } from './ui';

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
    <div className="price-lines" aria-label={L('요금 상세', 'Price breakdown')}>
      {q.lines.map((l, i) => (
        <div key={i} className="line">
          <span>{LABELS[l.code?.toUpperCase()]?.[lang] ?? l.label}</span>
          <Money minor={l.amountMinor} currency={q.currency} />
        </div>
      ))}
      <div className="line total">
        <span>{L('총액', 'Total')}</span>
        <Money minor={q.totalMinor} currency={q.currency} />
      </div>
      {q.expiresAt && (
        <p className="small muted" style={{ margin: 0 }}>
          {L('견적 유효기간', 'Quote valid until')}: <DateText value={q.expiresAt} time />
        </p>
      )}
    </div>
  );
}
