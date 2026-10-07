// Shared state enums (mirror DB CHECK constraints in packages/db/migrations). Keep in sync.
export const ReservationStatus = ['DRAFT','QUOTED','HELD','PAYMENT_PENDING','PAYMENT_FAILED','EXPIRED','CONFIRMED','CHECKED_IN','COMPLETED','CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','NO_SHOW','DISPUTED'];
export const ExchangeStatus = ['REQUESTED','COUNTERED','MUTUAL_ACCEPTED','VERIFICATION_PENDING','AGREEMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED','DECLINED','WITHDRAWN','EXPIRED','DISPUTED','CANCELLED'];
export const GuideBookingStatus = ['ACCEPTED','PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED','CANCELLED','DISPUTED','PAYMENT_FAILED'];
export const GuideType = ['FRIEND','VOLUNTEER','PAID','PROFESSIONAL'];
export const PaymentStatus = ['CREATED','CONFIRMING','APPROVED','FAILED','CANCELLED','PARTIALLY_REFUNDED','REFUNDED'];
export const RefundStatus = ['REQUESTED','PROVIDER_PENDING','PARTIAL','REFUNDED','FAILED'];
export const SettlementStatus = ['DRAFT','READY','APPROVAL_PENDING','APPROVED','PAYOUT_PENDING','PAID','RECONCILED','HELD'];
export const OrderStatus = ['CART','PENDING','PAYMENT_PENDING','PAID','FULFILLED','CANCELLED','PARTIALLY_REFUNDED','REFUNDED','PAYMENT_FAILED','EXPIRED'];
export const Roles = ['USER','HOST','GUIDE','SUPPLIER','ADMIN','ACCOUNTING','SUPPORT','EDITOR','COMPLIANCE'];
export const FeatureFlags = ['stay.paid_booking','exchange.enabled','guide.paid','travel.commerce','charter.direct_booking','ai.assistant','ai.recommendations','payout.automatic','integrations.pms'];
