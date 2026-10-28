import { NextResponse } from "next/server";
import { registerUser, createSessionCookieHeader } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_register", 10, 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const storeRoot = getDefaultStoreRoot();
    const { user, token } = await registerUser(body, storeRoot);

    const response = NextResponse.json({ user, token }, { status: 201 });
    response.headers.set("Set-Cookie", createSessionCookieHeader(token));
    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Registration failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
