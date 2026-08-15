import { enqueueCommand } from "@core/knowledge/commands.js";
import { canRun } from "@core/auth/users.js";
import { isResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * The ONLY write path from the console, and it writes a command — never application state.
 * The worker applies it. Every guard that prevents a double submission lives on the worker
 * side, so a malicious or buggy request here cannot bypass them.
 */
const ALLOWED = new Set(["approve", "skip", "change", "retry", "sweep", "refresh_list", "send_review_email", "update_answers"]);

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const name = String(body.name ?? "");
  if (!ALLOWED.has(name)) return Response.json({ error: `Unknown command "${name}"` }, { status: 400 });
  if (!canRun(user.role, name)) {
    return Response.json({ error: `Your role (${user.role}) cannot run "${name}".` }, { status: 403 });
  }

  const needsCode = ["approve", "skip", "change", "retry", "send_review_email"].includes(name);
  if (needsCode && !body.code) return Response.json({ error: "Missing job code" }, { status: 400 });
  if (name === "change" && !String(body.instruction ?? "").trim()) {
    return Response.json({ error: "Describe the change" }, { status: 400 });
  }

  const { name: _drop, ...rest } = body;
  const command = await enqueueCommand({ name, ...rest, source: "web", actor: user.username } as never);

  return Response.json({
    ok: true,
    id: command.id,
    message: `${name} queued — the worker picks it up within a few seconds.`,
  });
}
