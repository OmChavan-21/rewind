import { NextResponse } from "next/server";
import { resendEmailVerificationOtp } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_resend_otp", 3, 60_000);
  if (rateLimitRes) return rateLimitRes;
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email : "";
    if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });
    await resendEmailVerificationOtp(email, getDefaultStoreRoot());
    return NextResponse.json({ success: true, message: "A new verification code has been sent." });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not resend verification code.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
