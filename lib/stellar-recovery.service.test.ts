import type { PendingStellarTransaction } from "@/lib/stellar-recovery.types";

jest.mock("@/lib/stellar-recovery.repository", () => ({
  StellarRecoveryRepository: jest.fn(),
}));

jest.mock("@/lib/activity-logger", () => ({
  appendActivityLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/stellar", () => ({
  submitOwnershipTransferMemoToStellar: jest.fn(),
  submitHashToStellar: jest.fn(),
  submitBatchHashToStellar: jest.fn(),
  mintSnippetLicenseOnStellar: jest.fn(),
  classifyStellarError: jest.fn().mockReturnValue({ retryable: false, reason: "unknown_error" }),
}));

jest.mock("@neondatabase/serverless", () => ({
  neon: jest.fn(() => jest.fn()),
}));

jest.mock("stellar-sdk", () => ({
  Horizon: {
    Server: jest.fn(() => ({
      transactions: jest.fn(() => ({
        hash: jest.fn(() => ({
          call: jest.fn().mockResolvedValue({ ledger: 12345 }),
        })),
      })),
    })),
  },
}));

import { StellarRecoveryService } from "@/lib/stellar-recovery.service";
import { StellarRecoveryRepository } from "@/lib/stellar-recovery.repository";
import * as stellar from "@/lib/stellar";

function createMockRecord(
  overrides: Partial<PendingStellarTransaction> = {},
): PendingStellarTransaction {
  return {
    id: "test-id-1",
    idempotency_key: "own:abc:old:new:2026-08-26",
    tx_type: "ownership_transfer",
    status: "pending",
    payload: {
      snippetId: "snippet-1",
      oldOwnerWalletAddress: "GOLDOWNER12345678901234567890123456789012345678901234567",
      newOwnerWalletAddress: "GNEWOWNER12345678901234567890123456789012345678901234567",
    },
    stellar_tx_hash: null,
    stellar_ledger: null,
    attempt_count: 0,
    max_attempts: 5,
    last_error: null,
    next_retry_at: null,
    callback_status: "pending",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("StellarRecoveryService", () => {
  let service: StellarRecoveryService;
  let repo: jest.Mocked<StellarRecoveryRepository>;

  beforeEach(() => {
    repo = {
      createPending: jest.fn(),
      findByIdempotencyKey: jest.fn(),
      findById: jest.fn(),
      findBySnippetId: jest.fn(),
      markSubmitted: jest.fn(),
      markConfirmed: jest.fn(),
      markApplied: jest.fn(),
      markFailed: jest.fn(),
      markDead: jest.fn(),
      markCallbackFailed: jest.fn(),
      findRetryable: jest.fn(),
      findConfirmedNeedingCallback: jest.fn(),
    } as any;

    service = new StellarRecoveryService(repo);
    jest.clearAllMocks();
  });

  describe("submitOwnershipTransfer", () => {
    it("returns existing record on idempotent hit", async () => {
      const existing = createMockRecord({ status: "confirmed", callback_status: "applied" });
      repo.findByIdempotencyKey.mockResolvedValue(existing);

      const result = await service.submitOwnershipTransfer({
        idempotencyKey: "own:abc:old:new:2026-08-26",
        snippetId: "snippet-1",
        oldOwnerWalletAddress: "GOLD",
        newOwnerWalletAddress: "GNEW",
      });

      expect(result).toBe(existing);
      expect(repo.createPending).not.toHaveBeenCalled();
    });

    it("creates pending record and submits to Horizon", async () => {
      repo.findByIdempotencyKey.mockResolvedValue(null);
      const record = createMockRecord();
      repo.createPending.mockResolvedValue(record);

      (stellar.submitOwnershipTransferMemoToStellar as jest.Mock).mockResolvedValue({
        success: true,
        transactionHash: "tx-hash-123",
        ledger: 100,
        memo: "tr:test:old:new",
      });

      const result = await service.submitOwnershipTransfer({
        idempotencyKey: "own:abc:old:new:2026-08-26",
        snippetId: "snippet-1",
        oldOwnerWalletAddress: "GOLD",
        newOwnerWalletAddress: "GNEW",
      });

      expect(repo.createPending).toHaveBeenCalledWith({
        idempotencyKey: "own:abc:old:new:2026-08-26",
        txType: "ownership_transfer",
        payload: expect.objectContaining({
          snippetId: "snippet-1",
        }),
      });
      expect(repo.markSubmitted).toHaveBeenCalledWith({
        id: "test-id-1",
        stellarTxHash: "tx-hash-123",
      });
    });

    it("marks record dead on permanent error", async () => {
      repo.findByIdempotencyKey.mockResolvedValue(null);
      const record = createMockRecord();
      repo.createPending.mockResolvedValue(record);

      (stellar.submitOwnershipTransferMemoToStellar as jest.Mock).mockResolvedValue({
        success: false,
        error: "Stellar tx_bad_auth: invalid signature",
      });
      (stellar.classifyStellarError as jest.Mock).mockReturnValue({
        retryable: false,
        reason: "tx_bad_auth",
      });

      await service.submitOwnershipTransfer({
        idempotencyKey: "own:abc:old:new:2026-08-26",
        snippetId: "snippet-1",
        oldOwnerWalletAddress: "GOLD",
        newOwnerWalletAddress: "GNEW",
      });

      expect(repo.markDead).toHaveBeenCalledWith({
        id: "test-id-1",
        error: "Stellar tx_bad_auth: invalid signature",
      });
    });

    it("marks record failed (retryable) on network error", async () => {
      repo.findByIdempotencyKey.mockResolvedValue(null);
      const record = createMockRecord();
      repo.createPending.mockResolvedValue(record);

      (stellar.submitOwnershipTransferMemoToStellar as jest.Mock).mockResolvedValue({
        success: false,
        error: "Network timeout",
      });
      (stellar.classifyStellarError as jest.Mock).mockReturnValue({
        retryable: true,
        reason: "network_timeout",
      });

      await service.submitOwnershipTransfer({
        idempotencyKey: "own:abc:old:new:2026-08-26",
        snippetId: "snippet-1",
        oldOwnerWalletAddress: "GOLD",
        newOwnerWalletAddress: "GNEW",
      });

      expect(repo.markFailed).toHaveBeenCalledWith({
        id: "test-id-1",
        error: "Network timeout",
        nextRetryAt: expect.any(Date),
      });
    });
  });

  describe("submitHashAnchoring", () => {
    it("creates pending record with correct idempotency key", async () => {
      repo.findByIdempotencyKey.mockResolvedValue(null);
      const record = createMockRecord({
        tx_type: "hash_anchoring",
        payload: { snippetId: "s1", contentHash: "abc123", createdAt: "2026-01-01" },
      });
      repo.createPending.mockResolvedValue(record);

      (stellar.submitHashToStellar as jest.Mock).mockResolvedValue({
        success: true,
        transactionHash: "hash-tx-1",
        ledger: 200,
      });

      await service.submitHashAnchoring({
        idempotencyKey: "hash:s1:abc123def456",
        snippetId: "s1",
        contentHash: "abc123",
      });

      expect(repo.createPending).toHaveBeenCalledWith({
        idempotencyKey: "hash:s1:abc123def456",
        txType: "hash_anchoring",
        payload: expect.objectContaining({ snippetId: "s1" }),
      });
    });
  });

  describe("submitLicenseMint", () => {
    it("returns existing record on idempotent hit", async () => {
      const existing = createMockRecord({
        tx_type: "license_mint",
        status: "confirmed",
        callback_status: "applied",
      });
      repo.findByIdempotencyKey.mockResolvedValue(existing);

      const result = await service.submitLicenseMint({
        idempotencyKey: "lic:s1:MIT",
        snippetId: "s1",
        licenseType: "MIT",
        ownerWalletAddress: "GWALLET",
      });

      expect(result).toBe(existing);
      expect(repo.createPending).not.toHaveBeenCalled();
    });
  });

  describe("processRecoveryBatch", () => {
    it("retries pending transactions and applies confirmed callbacks", async () => {
      const retryable = createMockRecord({ status: "pending", attempt_count: 1 });
      repo.findRetryable.mockResolvedValue([retryable]);
      repo.findConfirmedNeedingCallback.mockResolvedValue([]);

      (stellar.submitOwnershipTransferMemoToStellar as jest.Mock).mockResolvedValue({
        success: true,
        transactionHash: "retry-tx-1",
        ledger: 300,
      });

      const summary = await service.processRecoveryBatch();

      expect(summary.checked).toBe(1);
      expect(summary.retried).toBe(1);
    });

    it("applies callback for confirmed transactions", async () => {
      repo.findRetryable.mockResolvedValue([]);
      const confirmed = createMockRecord({
        status: "confirmed",
        callback_status: "pending",
        stellar_tx_hash: "confirmed-tx",
      });
      repo.findConfirmedNeedingCallback.mockResolvedValue([confirmed]);

      const mockSql = jest.fn();
      mockSql.mockResolvedValue([{ owner_wallet_address: "GOLD" }]);
      mockSql.mockResolvedValue([{ id: "1" }]);
      const { neon } = require("@neondatabase/serverless");
      neon.mockReturnValue(mockSql);

      const summary = await service.processRecoveryBatch();

      expect(summary.applied).toBe(1);
    });

    it("counts errors without throwing", async () => {
      repo.findRetryable.mockRejectedValue(new Error("DB connection lost"));
      repo.findConfirmedNeedingCallback.mockResolvedValue([]);

      const summary = await service.processRecoveryBatch();

      expect(summary.errors).toBe(1);
    });
  });

  describe("getBySnippetId", () => {
    it("delegates to repository", async () => {
      const records = [createMockRecord()];
      repo.findBySnippetId.mockResolvedValue(records);

      const result = await service.getBySnippetId("snippet-1");

      expect(result).toBe(records);
      expect(repo.findBySnippetId).toHaveBeenCalledWith("snippet-1");
    });
  });
});
