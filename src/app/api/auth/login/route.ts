import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, computeAuthToken, verifyPasscode } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const code = (body.code ?? "").trim();
  if (!verifyPasscode(code)) {
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }

  const token = await computeAuthToken();
  if (!token) {
    return NextResponse.json(
      { error: "The site passcode isn't configured yet on this deployment." },
      { status: 500 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90, // 90 days
  });
  return res;
}
