import { NextResponse } from "next/server";
import {
  getAuthenticatedUser,
  requestEmailVerification,
  sendFirebaseEmailVerification,
} from "@/server/auth";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  // Rate limit: 5 email verification requests per minute per IP
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_verify_email", 5, 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));

    // 1. If caller is an authenticated user whose email is already verified
    if (user && user.emailVerified) {
      return NextResponse.json({
        success: true,
        message: "Your email address is already verified.",
        alreadyVerified: true,
      });
    }

    // 2. If caller is an authenticated user needing email verification
    if (user) {
      const result = await requestEmailVerification(user.email, undefined, user.uid);
      return NextResponse.json(result);
    }

    // 3. If unauthenticated caller provides email and password
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";

    if (!email) {
      return NextResponse.json(
        { error: "A valid email address or authenticated session is required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
    if (password && apiKey) {
      const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      const data = await res.json();
      if (res.ok && data.idToken) {
        if (data.emailVerified) {
          return NextResponse.json({
            success: true,
            message: "Your email address is already verified.",
            alreadyVerified: true,
          });
        }
        const sent = await sendFirebaseEmailVerification(data.idToken, email);
        if (sent.error?.includes("TOO_MANY_ATTEMPTS_TRY_LATER")) {
          return NextResponse.json({
            success: true,
            message: `A verification email was recently sent to ${email}. Please check your inbox (including Spam) or wait a moment before requesting another.`,
          });
        }
        return NextResponse.json({
          success: true,
          message: `Verification email sent to ${email}. Please check your inbox.`,
        });
      }
    }

    // Fallback: Admin SDK generate link
    const result = await requestEmailVerification(email);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send verification email.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
