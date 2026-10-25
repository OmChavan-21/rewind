import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { applyApprovedAIProposal, ConflictError } from "@/server/proposalExecution";
import { SecurityError } from "@/security/boundaries";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { proposal, approved } = body;

    if (!approved) {
      return NextResponse.json(
        { error: "Explicit user approval is strictly required before applying AI proposals." },
        { status: 400 }
      );
    }

    if (!proposal || typeof proposal !== "object" || !Array.isArray(proposal.modifications)) {
      return NextResponse.json({ error: "Invalid or missing proposal object." }, { status: 400 });
    }

    const { workspaceRoot, storeRoot } = getContextRoots();
    const result = await applyApprovedAIProposal(workspaceRoot, storeRoot, proposal);

    const statusCode = result.success ? 200 : 422;
    return NextResponse.json({ result }, { status: statusCode });
  } catch (err: unknown) {
    if (err instanceof SecurityError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    const message = err instanceof Error ? err.message : "Error applying AI proposal";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
