import { neon } from "@neondatabase/serverless";
import type {
  CallbackStatus,
  PendingStellarTransaction,
  TxStatus,
} from "./stellar-recovery.types";

let sql: ReturnType<typeof neon> | null = null;
function getSql() {
  if (!sql) {
    sql = neon(process.env.DATABASE_URL!);
  }
  return sql;
}

export class StellarRecoveryRepository {
  async createPending(params: {
    idempotencyKey: string;
    txType: string;
    payload: Record<string, unknown>;
  }): Promise<PendingStellarTransaction> {
    const result = await getSql()`
      INSERT INTO stellar_pending_transactions (idempotency_key, tx_type, status, payload)
      VALUES (${params.idempotencyKey}, ${params.txType}, 'pending', ${JSON.stringify(params.payload)}::jsonb)
      ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;
    return result[0] as unknown as PendingStellarTransaction;
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<PendingStellarTransaction | null> {
    const result = await getSql()`
      SELECT * FROM stellar_pending_transactions WHERE idempotency_key = ${key}
    `;
    return (result[0] as unknown as PendingStellarTransaction) || null;
  }

  async findById(id: string): Promise<PendingStellarTransaction | null> {
    const result = await getSql()`
      SELECT * FROM stellar_pending_transactions WHERE id = ${id}
    `;
    return (result[0] as unknown as PendingStellarTransaction) || null;
  }

  async findBySnippetId(snippetId: string): Promise<PendingStellarTransaction[]> {
    const result = await getSql()`
      SELECT * FROM stellar_pending_transactions
      WHERE payload->>'snippetId' = ${snippetId}
      ORDER BY created_at DESC
    `;
    return result as unknown as PendingStellarTransaction[];
  }

  async markSubmitted(params: {
    id: string;
    stellarTxHash: string;
  }): Promise<void> {
    await getSql()`
      UPDATE stellar_pending_transactions
      SET status = 'submitted',
          stellar_tx_hash = ${params.stellarTxHash},
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  }

  async markConfirmed(params: {
    id: string;
    stellarLedger: number;
  }): Promise<void> {
    await getSql()`
      UPDATE stellar_pending_transactions
      SET status = 'confirmed',
          stellar_ledger = ${params.stellarLedger},
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  }

  async markApplied(id: string): Promise<void> {
    await getSql()`
      UPDATE stellar_pending_transactions
      SET callback_status = 'applied',
          updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  async markFailed(params: {
    id: string;
    error: string;
    nextRetryAt: Date;
  }): Promise<void> {
    await getSql()`
      UPDATE stellar_pending_transactions
      SET status = 'failed',
          last_error = ${params.error},
          next_retry_at = ${params.nextRetryAt},
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  }

  async markDead(params: { id: string; error: string }): Promise<void> {
    await getSql()`
      UPDATE stellar_pending_transactions
      SET status = 'dead',
          last_error = ${params.error},
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  }

  async markCallbackFailed(params: { id: string; error: string }): Promise<void> {
    await getSql()`
      UPDATE stellar_pending_transactions
      SET callback_status = 'failed',
          last_error = ${params.error},
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  }

  async findRetryable(limit: number): Promise<PendingStellarTransaction[]> {
    const result = await getSql()`
      SELECT * FROM stellar_pending_transactions
      WHERE status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND attempt_count < max_attempts
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return result as unknown as PendingStellarTransaction[];
  }

  async findConfirmedNeedingCallback(): Promise<PendingStellarTransaction[]> {
    const result = await getSql()`
      SELECT * FROM stellar_pending_transactions
      WHERE status = 'confirmed'
        AND callback_status = 'pending'
      ORDER BY created_at ASC
      LIMIT 20
    `;
    return result as unknown as PendingStellarTransaction[];
  }
}
