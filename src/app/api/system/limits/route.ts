import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getResourceLimits, getMemoryMetrics, computeDynamicLimits } from "@/security/limits";
import { checkFirebaseStatus } from "@/server/firebaseService";
import { getRAGProcessingStatus } from "@/server/ragService";
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
    const projId = searchParams.get("projectId") || undefined;

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projId);

    // If querying specific non-demo project limits, assert access
    if (projId && projId !== "demo-workspace") {
      const user = await requireAuthenticatedUser(request, storeRoot);
      await assertProjectAccessAsync(user, projId, storeRoot, "read");
    }

    const limits = getResourceLimits();
    const memoryMetrics = getMemoryMetrics(workspaceRoot, storeRoot);
    const dynamicLimits = computeDynamicLimits(memoryMetrics.storageMetrics.workspaceDiskUsedBytes);
    const ragStatus = getRAGProcessingStatus(storeRoot);
    const firebaseStatus = await checkFirebaseStatus();

    return NextResponse.json({
      projectId,
      limits,
      dynamicLimits,
      memoryMetrics,
      ragStatus,
      firebaseStatus,
    });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Error retrieving system limits";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
