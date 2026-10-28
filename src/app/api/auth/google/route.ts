import { NextResponse } from "next/server";
import {
  authenticateWithGoogleIdToken,
  createSessionCookieHeader,
  AuthenticationError,
} from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_google", 10, 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";

    if (!idToken) {
      return NextResponse.json(
        { error: "Google idToken is required in request body." },
        { status: 400 }
      );
    }

    const storeRoot = getDefaultStoreRoot();
    const { user, token } = await authenticateWithGoogleIdToken(idToken, storeRoot);

    const response = NextResponse.json({ user, token }, { status: 200 });
    response.headers.set("Set-Cookie", createSessionCookieHeader(token));
    return response;
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Google authentication failed.";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
