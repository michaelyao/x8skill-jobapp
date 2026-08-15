import { readWorkerStatus, isStale } from "@core/knowledge/workerStatus.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unauthenticated so the reverse proxy can health-check it. Reports only liveness — never
 * application data.
 */
export async function GET(): Promise<Response> {
  const status = await readWorkerStatus();
  return Response.json({
    ok: true,
    worker: status ? (isStale(status) ? "stale" : status.state) : "never-started",
  });
}
