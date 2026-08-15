import { authenticate, signSession } from "@core/auth/users.js";
import { SESSION_COOKIE } from "@/lib/constants";
import { ensureEnv } from "@/lib/env";

export const runtime = "nodejs"; // scrypt + HMAC need node:crypto

/**
 * Login. Failures are deliberately uniform ("invalid username or password") and
 * `authenticate` does the scrypt work even for unknown users, so neither the message nor the
 * timing reveals which accounts exist.
 */

const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

export async function POST(request: Request): Promise<Response> {
  ensureEnv();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) {
    return Response.json({ error: "Too many attempts. Wait a few minutes." }, { status: 429 });
  }

  let username = "";
  let password = "";
  try {
    const body = await request.json();
    username = String(body.username ?? "");
    password = String(body.password ?? "");
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const user = authenticate(username, password);
  if (!user) return Response.json({ error: "Invalid username or password" }, { status: 401 });

  const token = signSession(user);
  if (!token) {
    // A missing/short WEB_SESSION_SECRET is a config error. Say so plainly rather than
    // signing with a throwaway key that would drop every session on the next restart.
    return Response.json({ error: "Server is missing WEB_SESSION_SECRET (32+ chars)." }, { status: 500 });
  }

  const secure = (request.headers.get("x-forwarded-proto") ?? "http") === "https";
  const response = Response.json({ ok: true, user });
  response.headers.append(
    "set-cookie",
    [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      secure ? "Secure" : "",
      `Max-Age=${30 * 24 * 60 * 60}`,
    ]
      .filter(Boolean)
      .join("; "),
  );
  return response;
}
