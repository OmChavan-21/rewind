import { NextResponse } from "next/server";
import { checkNebiusStatus, getAIConfig } from "@/server/nebiusService";
import { getModelsForProvider } from "@/server/ai/modelCatalog";
import { getActiveProvider } from "@/server/ai/providerRegistry";
import {
  getCreditSchedule,
  getProjectCreditBalance,
} from "@/server/ai/dualAccounting";
import { getContextRoots } from "@/server/workspaceContext";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;
    const { storeRoot } = getContextRoots(projectIdParam);
    const activeProjectId = projectIdParam || "demo-workspace";

    // If querying a specific non-demo project's status, assert access
    if (projectIdParam && projectIdParam !== "demo-workspace") {
      const user = await requireAuthenticatedUser(request, storeRoot);
      await assertProjectAccessAsync(user, projectIdParam, storeRoot, "read");
    }

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
    if (
      err instanceof AuthenticationError ||
      err instanceof ForbiddenError ||
      err instanceof NotFoundError
    ) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    const config = getAIConfig();
    const msg = err instanceof Error ? err.message : "Error checking AI status";
    return NextResponse.json(
      {
        status: {
          state: "failed",
          provider: getActiveProvider(),
          configured: Boolean(config.apiKey),
          message: msg,
        },
      },
      { status: 500 }
    );
  }
}
