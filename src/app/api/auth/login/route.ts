import { NextResponse } from "next/server";
import { loginUser, createSessionCookieHeader, EmailVerificationRequiredError, resendEmailVerificationOtp } from "@/server/auth";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_login", 10, 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  let loginEmail = "";
  try {
    const body = await request.json().catch(() => ({}));
    loginEmail = typeof body.email === "string" ? body.email : "";
    const storeRoot = getDefaultStoreRoot();
    const { user, token } = await loginUser(body, storeRoot);

    const response = NextResponse.json({ user, token });
    response.headers.set("Set-Cookie", createSessionCookieHeader(token));
    return response;
  } catch (error: unknown) {
    if (error instanceof EmailVerificationRequiredError) {
      const otpRateLimitRes = await enforceRateLimitAsync(request, "auth_resend_otp", 3, 60_000);
      if (otpRateLimitRes) {
        return NextResponse.json(
          { requiresEmailVerification: true, otpSent: false, error: "Too many verification codes requested. Please wait a minute and try again." },
          { status: 429 }
        );
      }

      try {
        await resendEmailVerificationOtp(loginEmail, getDefaultStoreRoot());
        return NextResponse.json({
          requiresEmailVerification: true,
          otpSent: true,
          message: "Your email is not verified. A new six-digit code has been sent. Enter it to continue.",
        });
      } catch {
        return NextResponse.json(
          { requiresEmailVerification: true, otpSent: false, error: "Your email is not verified, but we could not send a new code. Please try Resend code after checking the email settings." },
          { status: 503 }
        );
      }
    }

    const message = error instanceof Error ? error.message : "Invalid credentials.";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
