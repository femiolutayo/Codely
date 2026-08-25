import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { SnippetService } from "../../snippet.service";
import { SnippetRepository } from "../../snippet.repository";
import { OwnershipMiddleware } from "../../ownership.middleware";
import { appendActivityLog, extractIp, extractUserAgent } from "@/lib/activity-logger";

const repository = new SnippetRepository();
const service = new SnippetService(repository);

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

    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const fork = await service.forkSnippet(id, walletAddress, body);

    await appendActivityLog("snippet.forked", "snippet", {
      actorWallet: walletAddress,
      resourceId: fork.id,
      metadata: {
        originalSnippetId: id,
        title: fork.title,
        language: fork.language,
      },
      ipAddress: extractIp(req.headers),
      userAgent: extractUserAgent(req.headers),
    });

    return NextResponse.json(fork, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.errors },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message === "Source snippet not found") {
      return NextResponse.json(
        { error: "Source snippet not found" },
        { status: 404 },
      );
    }
    if (error instanceof Error && error.message === "Cannot fork your own snippet") {
      return NextResponse.json(
        { error: "Cannot fork your own snippet" },
        { status: 400 },
      );
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
