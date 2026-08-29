import { fileFeedback, listFeedback } from "@core/knowledge/feedback.js";
import { isResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * A note from the reviewer about what is wrong with an application.
 *
 * Deliberately NOT a command. Commands go to the worker, which can re-fill and submit but cannot
 * change its own code or the answer store — and "the transcript never uploaded" or "the GPA is
 * wrong" are usually about exactly that. These are addressed to whoever is fixing the system.
 *
 * Any signed-in role may file one: describing a problem is not an action on an application, and the
 * point is to lower the cost of reporting one to nearly zero.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const text = String(body.text ?? "").trim();
  if (!text) return Response.json({ error: "Write what is wrong first" }, { status: 400 });
  if (text.length > 8000) return Response.json({ error: "That is longer than 8000 characters" }, { status: 400 });

  const note = await fileFeedback({
    text,
    code: body.code ? String(body.code).toUpperCase() : undefined,
    company: body.company ? String(body.company) : undefined,
    title: body.title ? String(body.title) : undefined,
    by: user.username,
  });
  return Response.json({ ok: true, id: note.id, at: note.at });
}

/** The notes already filed, so the page can show what has been said and what came of it. */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const code = new URL(request.url).searchParams.get("code") ?? undefined;
  return Response.json({ notes: await listFeedback({ code, all: true }) });
}
