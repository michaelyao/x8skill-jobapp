import { SESSION_COOKIE } from "@/lib/constants";
import { publicUrl } from "@/lib/publicUrl";

export const runtime = "nodejs";

/** Form-post target, so signing out works without JavaScript. */
export async function POST(request: Request): Promise<Response> {
  // Same reasoning as the middleware: the public origin, not the socket we were reached on.
  const headers = new Headers({ location: publicUrl(request, "/login").toString() });
  headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}
