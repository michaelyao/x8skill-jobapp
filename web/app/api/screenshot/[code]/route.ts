import fs from "node:fs/promises";
import { findScreenshot } from "@/lib/store";
import { isResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Screenshots show the filled application — PII. Never serve one without a session. */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;

  const { code } = await params;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) return new Response("bad code", { status: 400 });

  const file = await findScreenshot(code);
  if (!file) return new Response("not found", { status: 404 });

  const bytes = await fs.readFile(file);
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=60" },
  });
}
