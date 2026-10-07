# ADR-0003 — Payments: TossPayments with server-side confirmation

- Status: Accepted · Date: 2026-10-07 · Modules: PAY-01, PAY-02, FIN-01 · Invariants: 3, 4, 9, 11

## Context
Korean card/easy-pay acceptance via a PG. The browser returns from the PG checkout to a success URL carrying
`paymentKey`, `orderId`, `amount` — all attacker-controllable. Card data must never touch JETPOOL systems.

## Decision
- Provider: **TossPayments** (payment widget / v2 SDK). Adapter interface in `modules/payments/provider.ts`; a
  `MOCK` provider exists for tests and is **rejected at startup in production** (`platform/config.ts`).
- Flow:
  1. `POST /v1/payments/toss/prepare` — server computes the amount from the subject (reservation/guide booking/
     order) via the payment-subject registry, creates `payments` (`CREATED`, `provider_order_id`, TTL).
  2. Browser completes checkout in Toss's hosted UI (no PAN/CVC in our DOM, logs or DB — invariant 9).
  3. `POST /v1/payments/toss/confirm` — server checks `orderId` ↔ payment row ↔ subject, **amount equality with the
     server-side amount**, payer identity, expiry; moves to `CONFIRMING`, calls Toss confirm with the secret key,
     then `APPROVED`/`FAILED`. The subject (e.g. reservation) is confirmed only through its registered handler after
     `APPROVED` (invariant 3). Idempotency-Key required.
  4. Webhooks `/v1/webhooks/toss` are stored (dedupe by event id) and **reconciled by re-fetching** the payment from
     Toss — the webhook body is never trusted.
  5. `payments.reconcile-confirming` (every 60 s) resolves `CONFIRMING` older than 120 s from the provider;
     `payments.expire` expires `CREATED` past TTL; `payments.refund-retry` retries refunds.
- Ledger: approval, refunds and PG settlement post balanced, append-only double-entry transactions
  (`postLedger`, idempotency key per source event).
- Secrets: `TOSS_SECRET_KEY`, `TOSS_WEBHOOK_SECRET` only in Secrets Manager; log redaction covers
  `x-toss-signature`, card-like fields.

## Consequences
- + A forged success redirect or webhook cannot confirm anything.
- + Provider outages degrade to `CONFIRMING` and self-heal via reconciliation; holds are protected (ADR-0004).
- − Extra provider round-trips (confirm + re-fetch); acceptable versus the risk.
- Ops: docs/runbooks/payment-reconciliation.md, webhook-replay.md. Merchant-of-record and settlement policy are
  G9 business decisions (not encoded here).
