import { NextResponse } from "next/server";
import { StellarRecoveryService } from "@/lib/stellar-recovery.service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");

    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const service = new StellarRecoveryService();
    const summary = await service.processRecoveryBatch();

    console.log("[Cron/StellarRecovery] Batch processed:", summary);

    return NextResponse.json({
      success: true,
      message: "Stellar transaction recovery batch completed",
      data: summary,
    });
  } catch (error) {
    console.error("[Cron/StellarRecovery] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Recovery batch failed",
      },
      { status: 500 },
    );
  }
}
