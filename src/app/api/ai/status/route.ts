import { NextResponse } from "next/server";
import { checkNebiusStatus, getAIConfig } from "@/server/nebiusService";

export async function GET() {
  try {
    const status = await checkNebiusStatus();
    return NextResponse.json({ status });
  } catch (err: unknown) {
    const config = getAIConfig();
    const msg = err instanceof Error ? err.message : "Error checking AI status";
    return NextResponse.json(
      {
        status: {
          state: "failed",
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          endpointReachable: false,
          credentialsAccepted: false,
          modelListed: false,
          generationVerified: false,
          message: msg,
        },
      },
      { status: 500 }
    );
  }
}
