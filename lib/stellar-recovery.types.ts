export type TxType =
  | "ownership_transfer"
  | "hash_anchoring"
  | "batch_hash"
  | "license_mint";

export type TxStatus = "pending" | "submitted" | "confirmed" | "failed" | "dead";

export type CallbackStatus = "pending" | "applied" | "failed";

export interface PendingStellarTransaction {
  id: string;
  idempotency_key: string;
  tx_type: TxType;
  status: TxStatus;
  payload: Record<string, unknown>;
  stellar_tx_hash: string | null;
  stellar_ledger: number | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  callback_status: CallbackStatus;
  created_at: string;
  updated_at: string;
}

export interface RecoverySummary {
  checked: number;
  submitted: number;
  confirmed: number;
  applied: number;
  retried: number;
  dead: number;
  errors: number;
}
