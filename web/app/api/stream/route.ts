import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "@core/config.js";
import { isStale, readWorkerStatus } from "@core/knowledge/workerStatus.js";
import { pendingCommands } from "@core/knowledge/commands.js";
import { requireUser, isResponse } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-sent events for live status. Polls mtimes rather than using fs.watch: watchers are
 * unreliable across editors and network volumes, and at one stat per second the cost is
 * irrelevant next to a page load.
 *
 * NOTE for the reverse proxy: this needs buffering OFF or the client sees nothing.
 */
const WATCH = ["worker-status.json", "pending-approvals.json", "applications.json"];

async function fingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const f of WATCH) {
    const stat = await fs.stat(path.join(DATA_DIR, f)).catch(() => null);
    parts.push(`${f}:${stat?.mtimeMs ?? 0}`);
  }
  const cmds = await pendingCommands();
  parts.push(`cmds:${cmds.length}`);
  return parts.join("|");
}

export async function GET(): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      let last = await fingerprint();
      const send = async (changed: boolean) => {
        const status = await readWorkerStatus();
        const payload = {
          worker: status,
          stale: isStale(status),
          pendingCommands: (await pendingCommands()).length,
          changed,
        };
        controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      await send(false);

      const timer = setInterval(async () => {
        if (closed) return;
        try {
          const now = await fingerprint();
          // Only tell the page to reload when application state actually moved — a heartbeat
          // alone must not cause a reload loop.
          const stateChanged = now.split("|").slice(1).join("|") !== last.split("|").slice(1).join("|");
          await send(stateChanged);
          last = now;
        } catch {
          /* keep the stream alive */
        }
      }, 2000);

      controller.enqueue(encoder.encode(": connected\n\n"));

      return () => {
        closed = true;
        clearInterval(timer);
      };
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
