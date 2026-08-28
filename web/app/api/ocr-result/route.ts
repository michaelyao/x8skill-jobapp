import { enqueueCommand } from "@core/knowledge/commands.js";
import { ensureEnv } from "@/lib/env";
import { timingSafeEqual, createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * x8ocr's callback receiver: an async extract job finished and this is the result.
 *
 * Deliberately NOT session-authenticated — the caller is a service, not a browser — and
 * deliberately NOT a writer of application state. Like /api/command it drops an intent and the
 * worker applies it, because the worker is the only process that may write
 * pending-approvals.json. This route does not even look at the OCR text: evaluating it here
 * would put a submit-blocking decision in the web tier, which is exactly the split the command
 * queue exists to prevent.
 *
 * Auth is the shared token this deployment gave x8ocr as `callbackToken`, echoed back as a
 * bearer. Adequate because both sides sit on this host; if x8ocr ever moves off-box, move to a
 * signed body.
 */

const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function authorized(request: Request): boolean {
  // LOAD .env FIRST. In the container the token lives in the ./.env:/jobapp/.env:ro mount, not in
  // compose's environment block, and nothing puts it into process.env until loadEnv() runs. Without
  // this the token reads as empty, the fail-closed branch fires, and x8ocr's callback gets a 401 it
  // does not retry — so every verdict is lost and every check quietly ages out to "unavailable".
  // Measured exactly that: OCR returned ok=true with 1077 chars, delivery failed with "callback 401".
  ensureEnv();
  const expected = (process.env.X8OCR_CALLBACK_TOKEN || "").trim();
  if (!expected) return false; // not configured => accept nothing
  const presented = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") ?? "").trim())?.[1]?.trim();
  if (!presented) return false;
  // Fixed-length digests so neither the comparison nor the token length leaks.
  return timingSafeEqual(sha(expected), sha(presented));
}

interface Callback {
  jobId?: string;
  state?: string;
  error?: string;
  result?: {
    ok?: boolean;
    markdown?: string;
    reason?: string;
    message?: string;
    /** Per-page layout blocks, when includeLayout was requested. */
    pages?: Array<{ blocks?: unknown[] }>;
    /** The engine's trust statement — carried across so the worker can decide whether to use
     *  the boxes. This route still does not interpret any of it. */
    capability?: Record<string, unknown>;
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Which application this verdict belongs to. x8ocr echoes back the callbackUrl it was given,
  // and submitOcrJob puts the job code in that URL's query string.
  const code = new URL(request.url).searchParams.get("code")?.trim();
  if (!code) return Response.json({ error: "Missing ?code" }, { status: 400 });

  let body: Callback;
  try {
    body = (await request.json()) as Callback;
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  // A failed extraction is not an error here: the verdict is "unavailable", which never blocks
  // an application. Returning 4xx would just make x8ocr stop retrying something that worked.
  const failed =
    body.state !== "done" ? (body.error ?? `job ${body.state ?? "unknown"}`)
    : body.result?.ok === false ? (body.result.reason ?? "extract failed")
    : undefined;

  // Blocks from every page, flattened. A long application screenshot is one page here, but
  // flattening costs nothing and avoids silently dropping the rest if that ever changes.
  const blocks = (body.result?.pages ?? []).flatMap((p) => p.blocks ?? []);

  const command = await enqueueCommand({
    name: "visual_check",
    code,
    source: "x8ocr",
    jobId: body.jobId,
    screenText: body.result?.markdown ?? "",
    ...(blocks.length ? { blocks } : {}),
    ...(body.result?.capability ? { capability: body.result.capability } : {}),
    ...(failed ? { failed } : {}),
  });

  return Response.json({ ok: true, queued: command.id });
}
