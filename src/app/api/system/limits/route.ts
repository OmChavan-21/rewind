import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getResourceLimits, getMemoryMetrics, computeDynamicLimits } from "@/security/limits";
import { checkFirebaseStatus } from "@/server/firebaseService";
import { getRAGProcessingStatus } from "@/server/ragService";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projId = searchParams.get("projectId") || undefined;

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projId);
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
    const message = error instanceof Error ? error.message : "Error retrieving system limits";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
