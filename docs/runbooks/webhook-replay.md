# Runbook — Webhook replay (TossPayments, PMS/integrations)

**Alerts:** `WebhooksUnprocessed`, `WebhookSignatureFailures`
**Owner:** Finance on-call (payments) / Platform on-call (integrations)
**Invariant 4:** every external callback is validated, replay-safe and idempotent.

## Design recap
- Every delivery is stored first in `webhook_events` with `UNIQUE (provider, external_event_id)` and a
  `payload_hash`. Re-delivery of the same event id is a no-op (HTTP 200).
- Toss webhooks are **not trusted by payload**: the handler re-fetches the payment from the Toss API with the
  secret key and reconciles from the provider response (`/v1/webhooks/toss`). A forged webhook therefore cannot
  approve anything — at worst it triggers a harmless re-fetch.
- Processing outcome: `processed_at` set on success, `process_error` on failure.

## 1. Find unprocessed / failed deliveries

```sql
SELECT id, provider, external_event_id, event_type, signature_valid, process_error, created_at
  FROM webhook_events
 WHERE processed_at IS NULL AND created_at > now() - interval '2 days'
 ORDER BY created_at LIMIT 100;
```

## 2. Replay options (in order of preference)

1. **Provider-side resend** — Toss merchant console → 웹훅 → failed deliveries → 재전송. Safe: deduplicated by
   `external_event_id`; already-processed events return 200 without side effects.
2. **Reconcile instead of replay** (payments) — for each affected payment call
   `POST /v1/admin/payments/{id}/reconcile` (ACCOUNTING/ADMIN, AAL2). This reads the authoritative provider state
   and is equivalent to a successful webhook.
   ```sql
   SELECT DISTINCT p.id FROM webhook_events w
     JOIN payments p ON p.payment_key = w.payload->>'paymentKey' OR p.provider_order_id = w.payload->>'orderId'
    WHERE w.processed_at IS NULL AND w.provider = 'TOSS';
   ```
3. **Local re-POST of a stored payload** (integrations only, staging first): re-send the stored `payload` to the
   endpoint from inside the VPC with the provider's signature headers if the provider supports re-signing.
   Never strip or bypass signature verification to "make it pass".

## 3. Signature failures
`signature_valid = false` spikes mean misconfigured secrets (rotated `TOSS_WEBHOOK_SECRET`) or spoofing.
- Compare the secret version in Secrets Manager (`jetpool/<env>/app`) with the provider console.
- If deliveries come from non-provider IPs → treat as a security incident (incident-response.md), keep the rows
  as evidence (do not delete).

## 4. Verify
- `jetpool_db_webhooks_unprocessed == 0`.
- For payments: re-run the triage query in payment-reconciliation.md §1 — no stuck `CONFIRMING`.
