import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/constants";
import { publicUrl } from "./lib/publicUrl";

/**
 * Gate every page and API route behind a session. Deliberately fails CLOSED: anything not
 * explicitly public requires a valid-looking cookie, and the routes themselves re-verify the
 * signature (middleware runs on the edge runtime, where node:crypto is unavailable, so the
 * cryptographic check happens in the route/page — this is the coarse gate, not the only one).
 */
const PUBLIC = ["/login", "/api/login", "/api/health"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  // Redirect to the PUBLIC origin, not the address this process was reached on. Next's
  // middleware requires an absolute Location, and deriving it from the request would send the
  // browser to http://127.0.0.1:3010 behind the proxy — unreachable, and the http downgrade
  // would drop the Secure session cookie.
  const next = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(publicUrl(request, `/login${next}`));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
