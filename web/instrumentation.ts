/**
 * Process startup. Next calls register() once per server process, which is the hook the 8-hour
 * tick needs — it replaces the `jobapp_scheduler` compose service (see src/scheduler.ts for why
 * that split was not worth its keep).
 *
 * The real work is in a separate module reached by dynamic import, and both halves of that matter:
 * Next bundles THIS file for the edge runtime too (middleware.ts puts the edge compiler in play),
 * and the scheduler reaches node:fs through @core/*. A static import would fail the edge build;
 * the NEXT_RUNTIME guard plus a lazy import keeps node-only code out of it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./instrumentation.node");
}
