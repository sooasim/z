-- 0400 EXCH-02/05/06 lifecycle timestamps (Agent D — Home Exchange). Forward-only.
-- respond_by: offer response deadline (request expiry job, EXCH-02).
ALTER TABLE exchange_requests
  ADD COLUMN respond_by timestamptz,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN cancelled_at timestamptz;

CREATE INDEX idx_exchange_open_respond_by ON exchange_requests(respond_by) WHERE status IN ('REQUESTED','COUNTERED');
CREATE INDEX idx_exchange_active_lifecycle ON exchange_requests(status) WHERE status IN ('CONFIRMED','IN_PROGRESS');
CREATE INDEX idx_exchange_verifications_exchange ON exchange_verifications(exchange_id);
