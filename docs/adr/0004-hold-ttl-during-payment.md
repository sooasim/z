# ADR-0004 — Hold TTL 15 minutes; holds with in-flight payments are never expired

- Status: Accepted · Date: 2026-10-07 · Modules: STAY-08, STAY-09, PAY-01 · Invariant: 5

## Context
A hold reserves dates (`inventory_blocks` HOLD + `reservation_holds`) while the guest pays. Too short and slow
payers lose dates mid-checkout; too long and inventory is locked by abandoned carts. The dangerous race: the hold
expires, another guest takes the dates, and the first guest's payment is approved by the PG a few seconds later.

## Decision
- `HOLD_TTL_SEC = 900` (15 min), equal to `PAYMENT_TTL_SEC`; quotes live 30 min (`QUOTE_TTL_SEC`).
- The worker job `booking.hold-expiry` (every 30 s) expires ACTIVE holds past `expires_at` **unless** the linked
  reservation has a payment in `CONFIRMING` or `APPROVED`. In that case the hold and its inventory block are
  extended by 5 minutes and re-evaluated, until the payment resolves:
  - `APPROVED` → payment-subject handler converts the hold into a RESERVATION block (same row/dates, no gap).
  - `FAILED`/`CANCELLED`/expired → the hold is released on the next sweep.
- `payments.reconcile-confirming` bounds how long a payment can stay `CONFIRMING` (provider re-fetch after 120 s),
  so extensions are bounded in practice.
- If a payment is approved for a subject that can no longer be confirmed (e.g. hold already released by an operator),
  the payment handler issues an automatic full refund and records it in the ledger.
- Availability is always rechecked inside the DB transaction that creates the hold; the exclusion constraint is the
  final arbiter (ADR-0002).

## Consequences
- + No oversell and no "paid but no room" in the provider-latency window.
- − A stuck provider can extend holds; alert `HoldExpiryBacklog` / `PaymentsStuckConfirming` and the reconciliation
  runbook cover it (docs/runbooks/hold-expiry-backlog.md).
