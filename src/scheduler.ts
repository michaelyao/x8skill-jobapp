import { loadEnv } from "./utils/env.js";
import { enqueueCommand, pendingCommands } from "./knowledge/commands.js";
import { DEFAULT_SWEEP_CAP } from "./core/selectJobs.js";
import { isStale, readWorkerStatus } from "./knowledge/workerStatus.js";

/**
 * The recurring tick: rebuild the job list, then queue the next batch of applications.
 *
 * Runs INSIDE the website process, started once from web/instrumentation.ts. It touches no
 * browser — it only writes a command file, which is why it can live somewhere with no Chrome in
 * it. The worker on the host picks the work up and drains it one application at a time.
 *
 * It used to be its own compose service (`jobapp_scheduler`), justified by "the image has no
 * cron". That reason never applied to this file: it was always a setInterval, never a cron job,
 * and the website already enqueues commands in-process (web/app/api/command/route.ts). The split
 * bought a second dist/ entrypoint and a hand-maintained copy of the website's volume block, and
 * nothing else. One image, one process, one set of mounts.
 *
 * Deliberately an interval and not a wall-clock schedule. "Every 8 hours" is about noticing new
 * postings, not about happening at 08:00; drift does not matter, and an interval also means a
 * restart checks immediately instead of waiting for the next slot.
 */

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (message: string): void => console.log(`scheduler: ${stamp()} ${message}`);

/** Read per-start, not at module load: the .env is loaded by the caller just before we start. */
function settings(): { everyMs: number; maxJobs: number; startupDelayMs: number } {
  return {
    everyMs: Number(process.env.SCHEDULE_EVERY_MS ?? 8 * 60 * 60 * 1000),
    maxJobs: Number(process.env.SCHEDULE_MAX_JOBS ?? DEFAULT_SWEEP_CAP),
    /** Give the worker a moment after a co-ordinated restart before handing it work. */
    startupDelayMs: Number(process.env.SCHEDULE_STARTUP_DELAY_MS ?? 30_000),
  };
}

export async function tick(maxJobs: number): Promise<void> {
  const worker = await readWorkerStatus();
  if (!worker || isStale(worker)) {
    // Queueing anyway would look like progress while nothing ran, and by the next tick there
    // would be two batches waiting. Say so and try again later.
    log("the worker is not running — nothing would execute a sweep, so not queueing one");
    return;
  }

  // Do not stack batches. One sweep can mean ten applications and each takes minutes, so if the
  // previous tick's work is still moving through the queue, this tick has nothing useful to add.
  const pending = await pendingCommands();
  const outstanding = pending.filter((c) => c.name === "sweep" || c.name === "refresh_list" || c.name === "apply");
  if (outstanding.length) {
    const counts = new Map<string, number>();
    for (const c of outstanding) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    log(`skipping — still ${[...counts].map(([n, k]) => `${k} ${n}`).join(", ")} queued from before`);
    return;
  }

  // refreshList makes the worker rebuild the list first, as its own command, so a slow scrape
  // does not sit inside the sweep.
  const cmd = await enqueueCommand({
    name: "sweep",
    maxJobs,
    refreshList: true,
    supportedOnly: true,
    latestFirst: true,
    source: "schedule",
  });
  log(`queued a sweep (${cmd.id}): refresh the list, then up to ${maxJobs} application(s)`);
}

/**
 * One timer per process. `next dev` re-runs instrumentation on every recompile, and two live
 * timers would mean two ticks racing to enqueue against the same queue.
 */
let timer: ReturnType<typeof setInterval> | undefined;

export function startScheduler(): void {
  if (timer) {
    log("already started in this process — not starting a second timer");
    return;
  }

  loadEnv();
  const { everyMs, maxJobs, startupDelayMs } = settings();
  if (everyMs <= 0) {
    log("SCHEDULE_EVERY_MS is 0 — the tick is disabled, nothing will be queued automatically");
    return;
  }

  const run = (): void => {
    void tick(maxJobs).catch((error) => log(`tick failed: ${(error as Error).message}`));
  };

  log(`started — every ${Math.round(everyMs / 60000)} min, up to ${maxJobs} job(s) per sweep`);
  // A bare setInterval so the first check happens after the startup delay, not a full period
  // later: a restart should notice new postings straight away.
  timer = setInterval(run, everyMs);
  if (startupDelayMs > 0) {
    log(`waiting ${Math.round(startupDelayMs / 1000)}s before the first tick`);
    setTimeout(run, startupDelayMs).unref?.();
  } else {
    run();
  }
}
