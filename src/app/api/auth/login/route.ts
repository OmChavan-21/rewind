import { NextResponse } from "next/server";
import { loginUser, createSessionCookieHeader } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const storeRoot = getDefaultStoreRoot();
    const { user, token } = await loginUser(body, storeRoot);

    const response = NextResponse.json({ user, token });
    response.headers.set("Set-Cookie", createSessionCookieHeader(token));
    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid credentials.";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
