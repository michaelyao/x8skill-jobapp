import { SESSION_COOKIE } from "@/lib/constants";

export const runtime = "nodejs";

/** Form-post target, so signing out works without JavaScript. */
export async function POST(request: Request): Promise<Response> {
  const headers = new Headers({ location: new URL("/login", request.url).toString() });
  headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}
