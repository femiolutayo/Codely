import * as StellarSdk from "stellar-sdk";
import { StellarRecoveryRepository } from "./stellar-recovery.repository";
import type {
  CallbackStatus,
  PendingStellarTransaction,
  RecoverySummary,
  TxStatus,
} from "./stellar-recovery.types";
import { appendActivityLog } from "./activity-logger";
import {
  submitOwnershipTransferMemoToStellar,
  submitHashToStellar,
  submitBatchHashToStellar,
  mintSnippetLicenseOnStellar,
  classifyStellarError,
} from "./stellar";
import { neon } from "@neondatabase/serverless";

const HORIZON_URL =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";

const POLL_DELAYS_MS = [2000, 5000, 15000, 30000];
const MAX_POLL_TIME_MS = 60_000;

function getSql() {
  return neon(process.env.DATABASE_URL!);
}

function computeBackoff(attemptCount: number): Date {
  const delayMs = Math.min(2 ** attemptCount * 30_000, 900_000);
  return new Date(Date.now() + delayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StellarRecoveryService {
  constructor(
    private readonly repo: StellarRecoveryRepository = new StellarRecoveryRepository(),
  ) {}

  async submitOwnershipTransfer(params: {
    idempotencyKey: string;
    snippetId: string;
    oldOwnerWalletAddress: string;
    newOwnerWalletAddress: string;
  }): Promise<PendingStellarTransaction> {
    const existing = await this.repo.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      console.log(
        "[StellarRecovery] Idempotent hit for ownership transfer:",
        params.idempotencyKey,
      );
      return existing;
    }

    const record = await this.repo.createPending({
      idempotencyKey: params.idempotencyKey,
      txType: "ownership_transfer",
      payload: {
        snippetId: params.snippetId,
        oldOwnerWalletAddress: params.oldOwnerWalletAddress,
        newOwnerWalletAddress: params.newOwnerWalletAddress,
      },
    });

    await this.submitToHorizon(record);
    return record;
  }

  async submitHashAnchoring(params: {
    idempotencyKey: string;
    snippetId: string;
    contentHash: string;
    createdAt?: string;
  }): Promise<PendingStellarTransaction> {
    const existing = await this.repo.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      console.log(
        "[StellarRecovery] Idempotent hit for hash anchoring:",
        params.idempotencyKey,
      );
      return existing;
    }

    const record = await this.repo.createPending({
      idempotencyKey: params.idempotencyKey,
      txType: "hash_anchoring",
      payload: {
        snippetId: params.snippetId,
        contentHash: params.contentHash,
        createdAt: params.createdAt,
      },
    });

    await this.submitToHorizon(record);
    return record;
  }

  async submitBatchHash(params: {
    idempotencyKey: string;
    snippets: Array<{ id: string; hash: string }>;
  }): Promise<PendingStellarTransaction> {
    const existing = await this.repo.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return existing;
    }

    const record = await this.repo.createPending({
      idempotencyKey: params.idempotencyKey,
      txType: "batch_hash",
      payload: { snippets: params.snippets },
    });

    await this.submitToHorizon(record);
    return record;
  }

  async submitLicenseMint(params: {
    idempotencyKey: string;
    snippetId: string;
    licenseType: string;
    ownerWalletAddress: string;
  }): Promise<PendingStellarTransaction> {
    const existing = await this.repo.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return existing;
    }

    const record = await this.repo.createPending({
      idempotencyKey: params.idempotencyKey,
      txType: "license_mint",
      payload: {
        snippetId: params.snippetId,
        licenseType: params.licenseType,
        ownerWalletAddress: params.ownerWalletAddress,
      },
    });

    await this.submitToHorizon(record);
    return record;
  }

  private async submitToHorizon(record: PendingStellarTransaction): Promise<void> {
    const payload = record.payload;

    try {
      let result;
      switch (record.tx_type) {
        case "ownership_transfer":
          result = await submitOwnershipTransferMemoToStellar({
            snippetId: payload.snippetId as string,
            oldOwnerWalletAddress: payload.oldOwnerWalletAddress as string,
            newOwnerWalletAddress: payload.newOwnerWalletAddress as string,
          });
          break;
        case "hash_anchoring":
          result = await submitHashToStellar(
            process.env.STELLAR_SECRET_KEY || "",
            payload.contentHash as string,
            payload.snippetId as string,
            payload.createdAt as string | undefined,
          );
          break;
        case "batch_hash":
          result = await submitBatchHashToStellar(
            process.env.STELLAR_SECRET_KEY || "",
            payload.snippets as Array<{ id: string; hash: string }>,
          );
          break;
        case "license_mint":
          result = await mintSnippetLicenseOnStellar({
            snippetId: payload.snippetId as string,
            licenseType: payload.licenseType as string,
            ownerWalletAddress: payload.ownerWalletAddress as string,
          });
          break;
        default:
          throw new Error(`Unknown tx_type: ${record.tx_type}`);
      }

      if (!result.success || !result.transactionHash) {
        const error = result.error || "Submission failed";
        const classification = classifyStellarError(error);

        if (classification.retryable) {
          const nextRetry = computeBackoff(record.attempt_count + 1);
          await this.repo.markFailed({ id: record.id, error, nextRetryAt: nextRetry });
          console.warn(
            `[StellarRecovery] Submission failed (retryable): ${record.tx_type} — ${error}`,
          );
        } else {
          await this.repo.markDead({ id: record.id, error });
          console.error(
            `[StellarRecovery] Submission failed (permanent): ${record.tx_type} — ${error}`,
          );
        }
        return;
      }

      await this.repo.markSubmitted({
        id: record.id,
        stellarTxHash: result.transactionHash,
      });

      await appendActivityLog("stellar.tx.submitted", "snippet", {
        resourceId: payload.snippetId as string | null,
        metadata: {
          txType: record.tx_type,
          stellarTxHash: result.transactionHash,
          attempt: record.attempt_count + 1,
        },
      });

      const confirmed = await this.pollForConfirmation(
        result.transactionHash,
      );
      if (confirmed) {
        await this.repo.markConfirmed({
          id: record.id,
          stellarLedger: confirmed,
        });

        await appendActivityLog("stellar.tx.confirmed", "snippet", {
          resourceId: payload.snippetId as string | null,
          metadata: {
            txType: record.tx_type,
            stellarTxHash: result.transactionHash,
            ledger: confirmed,
          },
        });

        await this.applyCallback(record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const nextRetry = computeBackoff(record.attempt_count + 1);
      await this.repo.markFailed({ id: record.id, error: message, nextRetryAt: nextRetry });
      console.error(
        `[StellarRecovery] Unexpected error during submission: ${record.tx_type} — ${message}`,
      );
    }
  }

  private async pollForConfirmation(txHash: string): Promise<number | null> {
    const server = new StellarSdk.Horizon.Server(HORIZON_URL);
    const startTime = Date.now();

    for (const delay of POLL_DELAYS_MS) {
      if (Date.now() - startTime > MAX_POLL_TIME_MS) {
        break;
      }

      await sleep(delay);

      try {
        const txBuilder = server.transactions().hash(txHash) as any;
        const response = await txBuilder.call();
        if (response && response.ledger) {
          return response.ledger;
        }
      } catch (err: any) {
        if (err?.response?.status === 404) {
          continue;
        }
        console.warn(
          `[StellarRecovery] Poll error for ${txHash}:`,
          err?.message,
        );
      }
    }

    return null;
  }

  private async applyCallback(record: PendingStellarTransaction): Promise<void> {
    const payload = record.payload;

    try {
      switch (record.tx_type) {
        case "ownership_transfer":
          await this.applyOwnershipTransfer(payload, record);
          break;
        case "hash_anchoring":
          await this.applyHashAnchoring(payload, record);
          break;
        case "batch_hash":
          await this.applyBatchHash(payload, record);
          break;
        case "license_mint":
          await this.applyLicenseMint(payload, record);
          break;
      }

      await this.repo.markApplied(record.id);

      await appendActivityLog("stellar.tx.applied", "snippet", {
        resourceId: payload.snippetId as string | null,
        metadata: {
          txType: record.tx_type,
          stellarTxHash: record.stellar_tx_hash,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Callback failed";
      await this.repo.markCallbackFailed({ id: record.id, error: message });
      console.error(
        `[StellarRecovery] Callback failed: ${record.tx_type} — ${message}`,
      );
    }
  }

  private async applyOwnershipTransfer(
    payload: Record<string, unknown>,
    record: PendingStellarTransaction,
  ): Promise<void> {
    const snippetId = payload.snippetId as string;
    const newOwner = payload.newOwnerWalletAddress as string;
    const oldOwner = payload.oldOwnerWalletAddress as string;

    const result = await getSql()`
      UPDATE snippets
      SET owner_wallet_address = ${newOwner},
          updated_at = NOW()
      WHERE id = ${snippetId}
        AND is_deleted = false
        AND owner_wallet_address = ${oldOwner}
      RETURNING *
    `;

    if (!result[0]) {
      const current = await getSql()`SELECT owner_wallet_address FROM snippets WHERE id = ${snippetId}`;
      if (current[0]?.owner_wallet_address?.toUpperCase() !== oldOwner.toUpperCase()) {
        console.warn(
          `[StellarRecovery] Ownership already changed for ${snippetId}, skipping DB update`,
        );
        return;
      }
      throw new Error("Failed to update snippet ownership");
    }

    await getSql()`
      INSERT INTO transactions (id, wallet_address, type, description, metadata, created_at)
      VALUES (
        ${crypto.randomUUID()},
        ${oldOwner},
        'snippet_owner_transfer',
        ${`Recovered transfer of snippet ${snippetId}`},
        ${JSON.stringify({
          snippetId,
          oldOwnerWalletAddress: oldOwner,
          newOwnerWalletAddress: newOwner,
          stellarTransactionHash: record.stellar_tx_hash,
          recovered: true,
        })}::jsonb,
        NOW()
      )
    `;
  }

  private async applyHashAnchoring(
    payload: Record<string, unknown>,
    _record: PendingStellarTransaction,
  ): Promise<void> {
    const snippetId = payload.snippetId as string;
    const contentHash = payload.contentHash as string;

    const existing = await getSql()`
      SELECT on_chain_hash FROM snippets WHERE id = ${snippetId}
    `;
    if (existing[0]?.on_chain_hash) {
      console.warn(
        `[StellarRecovery] Hash already stored for ${snippetId}, skipping`,
      );
      return;
    }

    await getSql()`
      UPDATE snippets
      SET on_chain_hash = ${contentHash},
          transaction_hash = ${_record.stellar_tx_hash},
          verified_at = NOW()
      WHERE id = ${snippetId}
    `;
  }

  private async applyBatchHash(
    payload: Record<string, unknown>,
    record: PendingStellarTransaction,
  ): Promise<void> {
    const snippets = payload.snippets as Array<{ id: string; hash: string }>;
    for (const snippet of snippets) {
      const existing = await getSql()`
        SELECT on_chain_hash FROM snippets WHERE id = ${snippet.id}
      `;
      if (existing[0]?.on_chain_hash) {
        continue;
      }
      await getSql()`
        UPDATE snippets
        SET on_chain_hash = ${snippet.hash},
            transaction_hash = ${record.stellar_tx_hash},
            verified_at = NOW()
        WHERE id = ${snippet.id}
      `;
    }
  }

  private async applyLicenseMint(
    payload: Record<string, unknown>,
    record: PendingStellarTransaction,
  ): Promise<void> {
    const snippetId = payload.snippetId as string;
    const licenseType = payload.licenseType as string;

    const existing = await getSql()`
      SELECT license_transaction_hash FROM snippets WHERE id = ${snippetId}
    `;
    if (existing[0]?.license_transaction_hash) {
      console.warn(
        `[StellarRecovery] License already minted for ${snippetId}, skipping`,
      );
      return;
    }

    await getSql()`
      UPDATE snippets
      SET license_transaction_hash = ${record.stellar_tx_hash},
          license_type = ${licenseType},
          license_metadata = ${JSON.stringify({
            type: licenseType,
            recovered: true,
          })}::jsonb
      WHERE id = ${snippetId}
    `;
  }

  async processRecoveryBatch(): Promise<RecoverySummary> {
    const summary: RecoverySummary = {
      checked: 0,
      submitted: 0,
      confirmed: 0,
      applied: 0,
      retried: 0,
      dead: 0,
      errors: 0,
    };

    let retryable: PendingStellarTransaction[] = [];
    try {
      retryable = await this.repo.findRetryable(20);
      summary.checked = retryable.length;
    } catch (error) {
      summary.errors++;
      console.error("[StellarRecovery] Error fetching retryable records:", error);
    }

    for (const record of retryable) {
      try {
        await this.retryTransaction(record);
        summary.retried++;
      } catch (error) {
        summary.errors++;
        console.error(
          `[StellarRecovery] Error processing ${record.id}:`,
          error,
        );
      }
    }

    let confirmedPending: PendingStellarTransaction[] = [];
    try {
      confirmedPending = await this.repo.findConfirmedNeedingCallback();
    } catch (error) {
      summary.errors++;
      console.error("[StellarRecovery] Error fetching confirmed records:", error);
    }

    for (const record of confirmedPending) {
      try {
        await this.applyCallback(record);
        summary.applied++;
      } catch (error) {
        summary.errors++;
        console.error(
          `[StellarRecovery] Error applying callback for ${record.id}:`,
          error,
        );
      }
    }

    return summary;
  }

  private async retryTransaction(record: PendingStellarTransaction): Promise<void> {
    console.log(
      `[StellarRecovery] Retrying ${record.tx_type} (attempt ${record.attempt_count + 1}): ${record.id}`,
    );
    await this.submitToHorizon(record);
  }

  async getStatus(
    id: string,
  ): Promise<PendingStellarTransaction | null> {
    return this.repo.findById(id);
  }

  async getStatusByKey(
    idempotencyKey: string,
  ): Promise<PendingStellarTransaction | null> {
    return this.repo.findByIdempotencyKey(idempotencyKey);
  }

  async getBySnippetId(
    snippetId: string,
  ): Promise<PendingStellarTransaction[]> {
    return this.repo.findBySnippetId(snippetId);
  }
}
