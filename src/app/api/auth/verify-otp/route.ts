import { NextResponse } from "next/server";
import { verifyEmailOtp } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_verify_otp", 10, 60_000);
  if (rateLimitRes) return rateLimitRes;

  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email : "";
    const code = typeof body.code === "string" ? body.code : "";
    if (!email || !/^\d{6}$/.test(code.trim())) {
      return NextResponse.json({ error: "Enter the six-digit code sent to your email." }, { status: 400 });
    }
    await verifyEmailOtp(email, code, getDefaultStoreRoot());
    return NextResponse.json({ success: true, message: "Email verified. You can now sign in." });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Email verification failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
