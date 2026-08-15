/**
 * Work out the URL the BROWSER used, which is not the URL this process received.
 *
 * Behind the reverse proxy the app is reached on http://127.0.0.1:3010 while the user is on
 * https://job.studiox8.com. Building a redirect from the incoming request would send the
 * browser to 127.0.0.1 over plain http — an unreachable host, and the downgrade to http would
 * drop the Secure session cookie, so login would appear to silently fail.
 *
 * Order of trust:
 *   1. PUBLIC_URL          — explicit, for when the proxy rewrites or strips headers
 *   2. X-Forwarded-Proto/Host — what a correctly configured proxy sends
 *   3. Host header          — direct access
 *
 * Edge-runtime safe: string handling only, no node APIs (middleware runs on the edge).
 */
export function publicOrigin(request: Request): string {
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host");
  const host = forwardedHost ?? headers.get("host");
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? (host?.includes("localhost") || host?.startsWith("127.") ? "http" : "https");

  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

/** An absolute URL on the public origin, for redirects. */
export function publicUrl(request: Request, pathAndQuery: string): URL {
  return new URL(pathAndQuery, `${publicOrigin(request)}/`);
}
