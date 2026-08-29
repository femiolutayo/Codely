import { logEvent } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SnippetRepository } from "../../snippet.repository";
import { OwnershipMiddleware } from "../../ownership.middleware";
import { SignatureMiddleware } from "../../signature.middleware";
import { appendActivityLog, extractUserAgent } from "@/lib/activity-logger";
import { createTransaction } from "@/lib/db";
import { StellarRecoveryService } from "@/lib/stellar-recovery.service";

const transferSchema = z.object({
  newOwnerWalletAddress: z
    .string()
    .min(56, "Invalid Stellar wallet address")
    .max(56, "Invalid Stellar wallet address"),
});

const repository = new SnippetRepository();
const ownershipMiddleware = new OwnershipMiddleware();
const signatureMiddleware = new SignatureMiddleware();
const recoveryService = new StellarRecoveryService();

function getIp(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  );
}

function buildIdempotencyKey(
  snippetId: string,
  oldOwner: string,
  newOwner: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  return `own:${snippetId.slice(0, 8)}:${oldOwner.slice(0, 8)}:${newOwner.slice(0, 8)}:${date}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const walletAddress = await OwnershipMiddleware.extractWalletAddress(req);
    if (!walletAddress) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Wallet address is required." },
        { status: 401 },
      );
    }

    const body = await req.json();
    const parsed = transferSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.errors,
        },
        { status: 400 },
      );
    }

    const { newOwnerWalletAddress } = parsed.data;

    if (walletAddress.toUpperCase() === newOwnerWalletAddress.toUpperCase()) {
      return NextResponse.json(
        { error: "Bad Request", message: "New owner must differ from current owner." },
        { status: 400 },
      );
    }

    const ownershipResult = await ownershipMiddleware.verifyOwnership(
      id,
      walletAddress,
      false,
    );
    if (!ownershipResult.isOwner) {
      return ownershipResult.error!;
    }

    const signatureResult = await signatureMiddleware.verifySignature(
      req,
      "transfer_ownership",
      id,
    );
    if (!signatureResult.isValid) {
      return signatureResult.error!;
    }

    const current = await repository.findById(id);
    if (!current) {
      return NextResponse.json(
        { error: "Not Found", message: "Snippet not found." },
        { status: 404 },
      );
    }

    const oldOwnerWalletAddress = (current as any).owner_wallet_address as
      | string
      | null;

    if (!oldOwnerWalletAddress) {
      return NextResponse.json(
        { error: "Bad Request", message: "Snippet has no owner set." },
        { status: 400 },
      );
    }

    // Atomic ownership update (guard by old owner)
    let updated = await (repository as any).transferOwnershipAtomic?.({
      snippetId: id,
    const idempotencyKey = buildIdempotencyKey(
      id,
      oldOwnerWalletAddress,
      newOwnerWalletAddress,
    );

    const existing = await recoveryService.getStatusByKey(idempotencyKey);
    if (existing && existing.status === "confirmed" && existing.callback_status === "applied") {
      const snippet = await repository.findById(id);
      return NextResponse.json(snippet, { status: 200 });
    }

    if (existing && existing.status === "dead") {
      return NextResponse.json(
        {
          error: "On-chain transfer proof failed permanently",
          message: existing.last_error || "Stellar transaction failed after max retries",
        },
        { status: 502 },
      );
    }

    if (existing && (existing.status === "pending" || existing.status === "submitted" || existing.status === "failed")) {
      return NextResponse.json(
        {
          status: "recovering",
          idempotencyKey,
          transactionId: existing.id,
          stellarTxHash: existing.stellar_tx_hash,
          attemptCount: existing.attempt_count,
          message: "Transaction is being processed. Poll /transaction-status for updates.",
        },
        { status: 202 },
      );
    }

    const record = await recoveryService.submitOwnershipTransfer({
      idempotencyKey,
      snippetId: id,
      oldOwnerWalletAddress,
      newOwnerWalletAddress,
    });

    if (record.status === "dead") {
      await appendActivityLog("snippet.owner_transfer_failed", "snippet", {
        actorWallet: walletAddress,
        resourceId: id,
        metadata: {
          oldOwnerWalletAddress,
          newOwnerWalletAddress,
          stellarError: record.last_error || "Unknown error",
        },
        ipAddress: getIp(req),
        userAgent: extractUserAgent(req.headers),
      });

      return NextResponse.json(
        {
          error: "On-chain transfer proof failed",
          message: record.last_error || "Stellar transaction failed permanently",
        },
        { status: 502 },
      );
    }

    if (record.status === "pending" || record.status === "failed") {
      return NextResponse.json(
        {
          status: "recovering",
          idempotencyKey,
          transactionId: record.id,
          attemptCount: record.attempt_count,
          message: "Transaction submission queued for retry. Poll /transaction-status for updates.",
        },
        { status: 202 },
      );
    }

    if (record.status === "submitted" && !record.stellar_tx_hash) {
      return NextResponse.json(
        {
          status: "recovering",
          idempotencyKey,
          transactionId: record.id,
          message: "Transaction submitted, awaiting confirmation. Poll /transaction-status for updates.",
        },
        { status: 202 },
      );
    }

    if (record.status === "confirmed" || (record.status === "submitted" && record.stellar_tx_hash)) {
      if (record.callback_status !== "applied") {
        return NextResponse.json(
          {
            status: "recovering",
            idempotencyKey,
            transactionId: record.id,
            stellarTxHash: record.stellar_tx_hash,
            message: "Transaction confirmed on-chain. Awaiting database update. Poll /transaction-status.",
          },
          { status: 202 },
        );
      }

      try {
        await createTransaction(
          walletAddress,
          "snippet_owner_transfer",
          `Transferred snippet ${id} ownership`,
          {
            snippetId: id,
            oldOwnerWalletAddress,
            newOwnerWalletAddress,
            stellarTransactionHash: record.stellar_tx_hash,
          },
        );
      } catch (err) {
        console.error("[transactions] Failed to log snippet_owner_transfer:", err);
      }

      await appendActivityLog("snippet.owner_transfer", "snippet", {
        actorWallet: walletAddress,
        resourceId: id,
        metadata: {
          oldOwnerWalletAddress,
          newOwnerWalletAddress,
          transactionHash: record.stellar_tx_hash,
        },
        ipAddress: getIp(req),
        userAgent: extractUserAgent(req.headers),
      });

      await logEvent("ownership_transferred", walletAddress, id, `Transferred to ${newOwnerWalletAddress}`);

      const updatedSnippet = await repository.findById(id);
      return NextResponse.json(updatedSnippet, { status: 200 });
    }

    return NextResponse.json(
      { error: "Unexpected transaction state", message: `Status: ${record.status}` },
      { status: 500 },
    );
  } catch (error) {
    console.error("[OwnershipTransfer] POST error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      { status: 500 },
    );
  }
}
