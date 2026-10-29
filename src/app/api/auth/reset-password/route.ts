import { NextResponse } from "next/server";
import { confirmPasswordReset } from "@/server/auth";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  // Rate limit: 5 password reset attempts per 15 minutes per IP
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_reset_password", 5, 15 * 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const oobCode = (body.oobCode || "").trim();
    const newPassword = body.newPassword || "";

    if (!oobCode) {
      return NextResponse.json(
        { error: "Reset action code is required." },
        { status: 400 }
      );
    }

    if (!newPassword || newPassword.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters long." },
        { status: 400 }
      );
    }

    const result = await confirmPasswordReset(oobCode, newPassword);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to reset password.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
