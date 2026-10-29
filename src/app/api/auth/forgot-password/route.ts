import { NextResponse } from "next/server";
import { sendPasswordResetEmail } from "@/server/auth";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(request: Request) {
  // Rate limit: 3 password recovery requests per 15 minutes per IP
  const rateLimitRes = await enforceRateLimitAsync(request, "auth_forgot_password", 3, 15 * 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return NextResponse.json(
        { error: "A valid email address is required." },
        { status: 400 }
      );
    }

    const result = await sendPasswordResetEmail(email);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to process recovery request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
