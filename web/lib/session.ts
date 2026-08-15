import { cookies } from "next/headers";
import { verifySession, type SessionPayload } from "@core/auth/users.js";
import { SESSION_COOKIE } from "./constants";
import { ensureEnv } from "./env";

export { SESSION_COOKIE } from "./constants";

/** The signed-in user for the current request, or null. */
export async function currentUser(): Promise<SessionPayload | null> {
  ensureEnv();
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * For route handlers: the user, or a 401. Middleware already gates page navigation, but API
 * routes verify independently — a route that trusts the middleware alone is one config
 * mistake away from being open.
 */
export async function requireUser(): Promise<SessionPayload | Response> {
  const user = await currentUser();
  return user ?? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
}

export const isResponse = (value: unknown): value is Response => value instanceof Response;
