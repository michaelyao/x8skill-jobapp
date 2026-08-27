import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/constants";
import { publicUrl } from "./lib/publicUrl";

/**
 * Gate every page and API route behind a session. Deliberately fails CLOSED: anything not
 * explicitly public requires a valid-looking cookie, and the routes themselves re-verify the
 * signature (middleware runs on the edge runtime, where node:crypto is unavailable, so the
 * cryptographic check happens in the route/page — this is the coarse gate, not the only one).
 */
/**
 * Exempt from the SESSION gate — not unauthenticated.
 *
 * `/api/ocr-result` is x8ocr's callback: the caller is a service on this host, not a browser, so
 * it has no session cookie and can never get one. It authenticates itself with the shared
 * `X8OCR_CALLBACK_TOKEN` (constant-time digest compare, and it rejects everything when the token
 * is unset), so the check moves into the route rather than disappearing.
 *
 * Leaving it out of this list is not a safe default here, it is a silent one: the middleware
 * answers 401 before the handler runs, x8ocr does not retry a 4xx, and every visual verdict is
 * lost while each check ages out to "unavailable" — verification quietly stops happening and
 * nothing reports that it has. Measured exactly that: `callback 401`, `{"error":"unauthorized"}`
 * from this file rather than from the route.
 */
const PUBLIC = ["/login", "/api/login", "/api/health", "/api/ocr-result"];

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
