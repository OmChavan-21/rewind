import { NextResponse } from "next/server";
import { clearSessionCookieHeader } from "@/server/auth";

export async function POST() {
  const response = NextResponse.json({ success: true, message: "Logged out successfully." });
  response.headers.set("Set-Cookie", clearSessionCookieHeader());
  return response;
}
