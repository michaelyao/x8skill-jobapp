import { startScheduler } from "@core/scheduler.js";

/**
 * Node-runtime side of instrumentation. Imported lazily from instrumentation.ts so nothing here
 * is ever bundled for the edge runtime.
 *
 * The tick is off in dev by default: `next dev` recompiles on every edit, and a sweep queued from
 * a dev server would hand real applications to the worker on the host. Set SCHEDULE_IN_DEV=1 to
 * exercise it deliberately.
 */
if (process.env.NODE_ENV === "production" || process.env.SCHEDULE_IN_DEV === "1") {
  startScheduler();
} else {
  console.log("scheduler: dev server — tick not started (set SCHEDULE_IN_DEV=1 to enable)");
}
