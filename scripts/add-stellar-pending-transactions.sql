CREATE TABLE IF NOT EXISTS stellar_pending_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  tx_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL,
  stellar_tx_hash VARCHAR(64),
  stellar_ledger BIGINT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ,
  callback_status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spt_status_retry
  ON stellar_pending_transactions(status, next_retry_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_spt_idempotency
  ON stellar_pending_transactions(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_spt_callback
  ON stellar_pending_transactions(callback_status)
  WHERE callback_status = 'pending' AND status = 'confirmed';
