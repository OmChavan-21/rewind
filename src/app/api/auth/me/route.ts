import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";

export async function GET(request: Request) {
  try {
    const storeRoot = getDefaultStoreRoot();
    const user = await getAuthenticatedUser(request, storeRoot);

    if (!user) {
      return NextResponse.json({ user: null, authenticated: false }, { status: 401 });
    }

    return NextResponse.json({ user, authenticated: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Authentication check failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
