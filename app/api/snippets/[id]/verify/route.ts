import { NextRequest, NextResponse } from "next/server";
import {
  getSnippetWithHash,
  verifySnippetIntegrity,
} from "@/lib/db";
import { generateSnippetHash } from "@/lib/hash";
import { StellarRecoveryService } from "@/lib/stellar-recovery.service";

const recoveryService = new StellarRecoveryService();

function buildIdempotencyKey(snippetId: string, contentHash: string): string {
  return `hash:${snippetId.slice(0, 8)}:${contentHash.slice(0, 16)}`;
}

/**
 * POST /api/snippets/[id]/verify
 *
 * Anchors the snippet's creation timestamp + content hash on the Stellar
 * blockchain, providing immutable proof-of-existence.
 *
 * Uses the recovery service for retry-safe processing. If the Stellar
 * submission fails with a retryable error, the transaction is queued
 * for automatic retry via the cron-based recovery engine.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const snippet = await getSnippetWithHash(id);
    if (!snippet) {
      return NextResponse.json({ error: "Snippet not found" }, { status: 404 });
    }

    if (snippet.on_chain_hash) {
      return NextResponse.json(
        {
          error:
            "Snippet is already verified on-chain. Timestamps are immutable.",
          data: {
            snippetId: id,
            onChainHash: snippet.on_chain_hash,
            transactionHash: snippet.transaction_hash,
            verifiedAt: snippet.verified_at,
            createdAt: snippet.created_at,
          },
        },
        { status: 409 },
      );
    }

    const onChainHash = generateSnippetHash(
      snippet.title,
      snippet.description || "",
      snippet.code,
      snippet.language,
      snippet.tags || [],
    );

    const createdAt: string =
      snippet.created_at instanceof Date
        ? snippet.created_at.toISOString()
        : String(snippet.created_at);

    console.log("[verify] Anchoring snippet on Stellar:", {
      id,
      onChainHash,
      createdAt,
    });

    const idempotencyKey = buildIdempotencyKey(id, onChainHash);

    const existing = await recoveryService.getStatusByKey(idempotencyKey);
    if (existing && existing.status === "confirmed" && existing.callback_status === "applied") {
      return NextResponse.json({
        success: true,
        message: "Snippet already anchored on Stellar blockchain",
        data: {
          snippetId: id,
          onChainHash,
          transactionHash: existing.stellar_tx_hash,
          verifiedAt: snippet.verified_at || new Date().toISOString(),
          createdAt,
        },
      });
    }

    if (existing && existing.status === "dead") {
      return NextResponse.json(
        {
          error: "Stellar anchoring failed permanently",
          details: existing.last_error,
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
          message: "Anchoring transaction is being processed. Poll /transaction-status for updates.",
        },
        { status: 202 },
      );
    }

    const record = await recoveryService.submitHashAnchoring({
      idempotencyKey,
      snippetId: id,
      contentHash: onChainHash,
      createdAt,
    });

    if (record.status === "dead") {
      return NextResponse.json(
        {
          error: "Failed to submit to Stellar blockchain",
          details: record.last_error,
        },
        { status: 502 },
      );
    }

    if (record.status !== "confirmed" || record.callback_status !== "applied") {
      return NextResponse.json(
        {
          status: "recovering",
          idempotencyKey,
          transactionId: record.id,
          stellarTxHash: record.stellar_tx_hash,
          message: record.stellar_tx_hash
            ? "Transaction confirmed. Awaiting database update."
            : "Anchoring transaction queued for processing.",
        },
        { status: 202 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Snippet creation timestamp anchored on Stellar blockchain",
      data: {
        snippetId: id,
        onChainHash,
        transactionHash: record.stellar_tx_hash,
        createdAt,
        verifiedAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error("[verify] Error anchoring snippet:", error);

    if (error?.message?.includes("immutable")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    return NextResponse.json(
      { error: "Failed to anchor snippet on blockchain" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/snippets/[id]/verify
 *
 * Verifies snippet integrity by comparing the current content hash against
 * the hash stored on the Stellar blockchain at creation time.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const snippet = await getSnippetWithHash(id);
    if (!snippet) {
      return NextResponse.json({ error: "Snippet not found" }, { status: 404 });
    }

    if (!snippet.on_chain_hash) {
      return NextResponse.json({
        verified: false,
        snippetId: id,
        message: "This snippet has not been anchored on the blockchain yet.",
        onChainHash: null,
        transactionHash: null,
        verifiedAt: null,
        createdAt: snippet.created_at,
      });
    }

    const result = await verifySnippetIntegrity(
      id,
      snippet.title,
      snippet.description || "",
      snippet.code,
      snippet.language,
      snippet.tags || [],
    );

    return NextResponse.json({
      verified: result.isValid,
      snippetId: id,
      message: result.message,
      onChainHash: snippet.on_chain_hash,
      transactionHash: snippet.transaction_hash,
      verifiedAt: snippet.verified_at,
      createdAt: snippet.created_at,
    });
  } catch (error) {
    console.error("[verify] Error verifying snippet:", error);
    return NextResponse.json(
      { error: "Failed to verify snippet integrity" },
      { status: 500 },
    );
  }
}
