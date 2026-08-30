import { NextRequest, NextResponse } from "next/server";
import { SnippetRepository } from "../../snippet.repository";
import { SnippetService } from "../../snippet.service";
import { OwnershipMiddleware } from "../../ownership.middleware";
import { createTransaction } from "@/lib/db";
import { ZodError } from "zod";

const repository = new SnippetRepository();
const service = new SnippetService(repository);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Empty body allows quick fork with defaults
    }

    // Extract wallet address
    let walletAddress = await OwnershipMiddleware.extractWalletAddress(req);
    if (!walletAddress && body.ownerWalletAddress) {
      walletAddress = body.ownerWalletAddress;
    }

    if (!walletAddress) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: "A connected wallet address is required to fork a snippet.",
        },
        { status: 401 },
      );
    }

    const forked = await service.forkSnippet(id, walletAddress, body);

    // Record on-chain / database transaction
    try {
      await createTransaction(
        walletAddress,
        "snippet_fork",
        `Forked snippet ${id} -> ${forked.id}`,
        { originalSnippetId: id, forkedSnippetId: forked.id },
      );
    } catch (txErr) {
      console.warn("[API] Failed to record transaction for snippet_fork:", txErr);
    }

    return NextResponse.json(forked, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.errors },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message === "Snippet not found") {
      return NextResponse.json({ error: "Original snippet not found" }, { status: 404 });
    }
    console.error("[API] Error forking snippet:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fork snippet" },
      { status: 500 },
    );
  }
}
