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

    // Extract wallet address
    let walletAddress = await OwnershipMiddleware.extractWalletAddress(req);

    // If body has title override or wallet address
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is valid for duplicate
    }

    if (!walletAddress && body.ownerWalletAddress) {
      walletAddress = body.ownerWalletAddress;
    }

    if (!walletAddress) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: "A connected wallet address is required to duplicate a snippet into your collection.",
        },
        { status: 401 },
      );
    }

    const duplicate = await service.duplicateSnippet(id, walletAddress, body.title);

    // Record on-chain / database transaction
    try {
      await createTransaction(
        walletAddress,
        "snippet_duplicate",
        `Duplicated snippet ${id} -> ${duplicate.id}`,
        { originalSnippetId: id, newSnippetId: duplicate.id },
      );
    } catch (txErr) {
      console.warn("[API] Failed to record transaction for snippet_duplicate:", txErr);
    }

    return NextResponse.json(duplicate, { status: 201 });
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
    console.error("[API] Error duplicating snippet:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to duplicate snippet" },
      { status: 500 },
    );
  }
}
