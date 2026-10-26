import { NextResponse } from "next/server";
import { checkNebiusStatus, getAIConfig } from "@/server/nebiusService";
import { getModelsForProvider } from "@/server/ai/modelCatalog";
import { getActiveProvider } from "@/server/ai/providerRegistry";
import {
  getCreditSchedule,
  getProjectCreditBalance,
} from "@/server/ai/dualAccounting";
import { getContextRoots } from "@/server/workspaceContext";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;
    const { storeRoot } = getContextRoots(projectIdParam);
    const activeProjectId = projectIdParam || "demo-workspace";

    const status = await checkNebiusStatus();
    const activeProvider = getActiveProvider();

    const availableModels = getModelsForProvider(activeProvider).map((m) => ({
      id: m.id,
      name: m.name,
      tier: m.tier,
      capabilities: m.capabilities,
      isDefault: m.isDefault ?? false,
      recommendedComplexity: m.recommendedComplexity,
      pricing: m.pricing
        ? {
            isVerified: m.pricing.isVerified,
            costStatus: m.pricing.isVerified ? "confirmed" : "estimated",
            promptTokenCostUSD: m.pricing.promptTokenCostUSD,
            completionTokenCostUSD: m.pricing.completionTokenCostUSD,
            source: m.pricing.source,
            verifiedAt: m.pricing.verifiedAt,
          }
        : null,
    }));

    const creditBalance = getProjectCreditBalance(activeProjectId, storeRoot);

    return NextResponse.json({
      status,
      provider: activeProvider,
      availableModels,
      supportedModes: ["auto", "manual"],
      creditAllowance: {
        totalAllowance: creditBalance.allowance,
        remainingCredits: creditBalance.remaining,
        usedCredits: creditBalance.used,
        schedule: getCreditSchedule(),
      },
    });
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
