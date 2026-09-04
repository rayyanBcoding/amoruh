import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";

// Site-wide passcode gate — runs in front of every route (Dashboard,
// Inventory, Intake, TV Display, and every API route) except the login
// page and its own auth endpoints. See src/lib/auth.ts and src/app/login.
export default async function proxy(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (await verifyAuthToken(token)) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except: the login page itself, its auth API routes,
    // Next's static/image assets, and the favicon.
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
