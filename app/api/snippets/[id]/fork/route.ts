import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { OwnershipMiddleware } from "../../ownership.middleware";
import { SnippetRepository } from "../../snippet.repository";
import { SnippetService } from "../../snippet.service";
import { appendActivityLog, extractIp, extractUserAgent } from "@/lib/activity-logger";
import { SnippetOwnershipProof } from "@/lib/snippet-ownership-proof";
import { createTransaction } from "@/lib/db";

const repository = new SnippetRepository();
const service = new SnippetService(repository);

/**
 * POST /api/snippets/{id}/fork
 * 
 * Fork an existing snippet with ownership proof.
 * Request body must include:
 * - ownershipProof: SnippetOwnershipProof containing signature from forker's wallet
 * 
 * Returns: The newly created forked snippet
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();

    // Extract forker's wallet address from headers
    const forkerWallet = await OwnershipMiddleware.extractWalletAddress(req);
    if (!forkerWallet) {
      return NextResponse.json(
        { error: "Wallet address required" },
        { status: 401 },
      );
    }

    // Validate that proof is included
    if (!body.ownershipProof) {
      return NextResponse.json(
        { error: "Ownership proof required for forking" },
        { status: 400 },
      );
    }

    // Fork the snippet
    const forkedSnippet = await service.forkSnippet(
      id,
      forkerWallet,
      body.ownershipProof as SnippetOwnershipProof,
    );

    // Log transaction
    try {
      await createTransaction(
        forkerWallet,
        "snippet_fork",
        `Forked snippet ${id}`,
        { originalSnippetId: id, forkedSnippetId: forkedSnippet.id },
      );
    } catch (err) {
      console.error("[transactions] Failed to log snippet_fork:", err);
    }

    // Log the fork action
    await appendActivityLog("snippet.forked", "snippet", {
      actorWallet: forkerWallet,
      resourceId: forkedSnippet.id,
      metadata: {
        title: forkedSnippet.title,
        language: forkedSnippet.language,
        originalSnippetId: id,
      },
      ipAddress: extractIp(req.headers),
      userAgent: extractUserAgent(req.headers),
    });

    return NextResponse.json(forkedSnippet, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.errors },
        { status: 400 },
      );
    }

    if (error instanceof Error) {
      if (error.message === "Original snippet not found") {
        return NextResponse.json(
          { error: error.message },
          { status: 404 },
        );
      }

      if (error.message.includes("proof")) {
        return NextResponse.json(
          { error: error.message },
          { status: 400 },
        );
      }
    }

    console.error("[API] Error forking snippet:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fork snippet",
      },
      { status: 500 },
    );
  }
}
