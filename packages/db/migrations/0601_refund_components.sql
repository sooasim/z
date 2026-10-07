-- 0601 PAY-02 / FIN-01: refund component breakdown. Forward-only.
-- fee_refund_minor = the part of a refund that returns the buyer-paid service fee + tax, as computed by the selling
-- domain under its snapshotted cancellation terms; amount_minor - fee_refund_minor returns the payees' gross
-- (supplier / host subtotal). The ledger reverses only the components that were actually refunded, so a
-- non-refundable service fee keeps its fee revenue and output VAT.
-- NULL = not specified (staff, provider-console and full refunds): the reversal stays pro rata over all approval credits.
ALTER TABLE refunds ADD COLUMN fee_refund_minor bigint
  CHECK (fee_refund_minor IS NULL OR (fee_refund_minor >= 0 AND fee_refund_minor <= amount_minor));
