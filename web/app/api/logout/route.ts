import { SESSION_COOKIE } from "@/lib/constants";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const response = Response.json({ ok: true });
  response.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return response;
}
