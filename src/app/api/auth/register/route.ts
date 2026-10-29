import { NextResponse } from "next/server";
import { registerUser, sendEmailVerificationOtp } from "@/server/auth";
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
    const { user } = await registerUser(body, storeRoot);
    try {
      await sendEmailVerificationOtp(user.email, storeRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not send verification email.";
      return NextResponse.json({ error: message, accountCreated: true, email: user.email }, { status: 503 });
    }
    return NextResponse.json({ success: true, email: user.email, message: "Verification code sent." }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Registration failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
