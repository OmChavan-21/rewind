import { NextResponse } from "next/server";
import { checkNebiusStatus, getAIConfig } from "@/server/nebiusService";
import { getModelsForProvider } from "@/server/ai/modelCatalog";
import { getActiveProvider } from "@/server/ai/providerRegistry";
import {
  getCreditSchedule,
} from "@/server/ai/dualAccounting";
import { getContextRoots } from "@/server/workspaceContext";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider } from "@/server/storage/storageProvider";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;
    const { storeRoot } = getContextRoots(projectIdParam);
    const activeProjectId = projectIdParam || "demo-workspace";
    const storage = getStorageProvider(storeRoot);
    let statusUser: Awaited<ReturnType<typeof requireAuthenticatedUser>> | undefined;

    // If querying a specific non-demo project's status, assert access
    if (projectIdParam && projectIdParam !== "demo-workspace") {
      statusUser = await requireAuthenticatedUser(request, storeRoot);
      await assertProjectAccessAsync(statusUser, projectIdParam, storeRoot, "read");
    }
    if (storage.mode === "cloud" && !statusUser) {
      statusUser = await requireAuthenticatedUser(request, storeRoot);
      await assertProjectAccessAsync(statusUser, activeProjectId, storeRoot, "read");
    }

    const activeProvider = getActiveProvider();
    const providerModels = getModelsForProvider(activeProvider);
    const statusModel = providerModels.find((model) => model.isDefault)?.id || providerModels[0]?.id;
    // Health-check the model Auto Router will actually use by default, rather than a stale
    // NEBIUS_MODEL value that may no longer exist in the provider catalog.
    const status = await checkNebiusStatus(statusModel);

    const availableModels = providerModels.map((m) => ({
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

    const creditBalance = await storage.credits.getBalance(activeProjectId, statusUser?.uid);

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
      providerUsage: creditBalance.providerUsage || {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
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
