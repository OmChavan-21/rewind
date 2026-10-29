import { NextResponse } from "next/server";
import { resendEmailVerificationOtp, sendFirebaseVerificationEmailForUser } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_resend_otp", 3, 60_000);
  if (rateLimitRes) return rateLimitRes;
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email : "";
    if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });
    try {
      await resendEmailVerificationOtp(email, getDefaultStoreRoot());
      return NextResponse.json({ success: true, verificationMethod: "otp", message: "A new verification code has been sent." });
    } catch {
      const fallback = await sendFirebaseVerificationEmailForUser(email);
      return NextResponse.json({ success: true, verificationMethod: "link", message: `${fallback.message} Open the link, then return here to sign in.` });
    }
  } catch {
    return NextResponse.json({ error: "Could not send a verification email. Please try again shortly." }, { status: 503 });
  }
}
