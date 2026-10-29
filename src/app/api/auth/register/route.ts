import { NextResponse } from "next/server";
import { registerUser, sendEmailVerificationOtp, sendFirebaseVerificationEmailForUser } from "@/server/auth";
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
      if (user.authProvider === "firebase") {
        try {
          const fallback = await sendFirebaseVerificationEmailForUser(user.email, user.uid);
          return NextResponse.json({
            success: true,
            email: user.email,
            verificationMethod: "link",
            message: `${fallback.message} Open the link, then return here to sign in.`,
          }, { status: 201 });
        } catch {
          return NextResponse.json({
            error: "Your account was created, but we could not send a verification email. Please try resending the link.",
            accountCreated: true,
            email: user.email,
            verificationMethod: "link",
          }, { status: 503 });
        }
      }
      const message = error instanceof Error ? error.message : "Could not send verification email.";
      return NextResponse.json({ error: message, accountCreated: true, email: user.email }, { status: 503 });
    }
    return NextResponse.json({ success: true, email: user.email, verificationMethod: "otp", message: "Verification code sent." }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Registration failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
