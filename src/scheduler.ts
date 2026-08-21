import { loadEnv } from "./utils/env.js";
import { enqueueCommand, pendingCommands } from "./knowledge/commands.js";
import { DEFAULT_SWEEP_CAP } from "./core/selectJobs.js";
import { isStale, readWorkerStatus } from "./knowledge/workerStatus.js";

/**
 * The recurring tick: rebuild the job list, then queue the next batch of applications.
 *
 * Runs in the WEBSITE CONTAINER, and touches no browser — it only writes a command file, which
 * is why it can live somewhere with no Chrome in it. The worker picks the work up and drains it
 * one application at a time.
 *
 * A separate process rather than cron inside the web container: the image has no cron, and
 * adding one would mean a supervisor running two things in a container built to run one. As its
 * own compose service with `restart: unless-stopped` it is supervised by Docker, restarts
 * cleanly, and its logs are its own.
 *
 * Deliberately an interval and not a wall-clock schedule. "Every 8 hours" is about noticing new
 * postings, not about happening at 08:00; drift does not matter, and an interval also means a
 * restart checks immediately instead of waiting for the next slot.
 */

loadEnv();

const EVERY_MS = Number(process.env.SCHEDULE_EVERY_MS ?? 8 * 60 * 60 * 1000);
const MAX_JOBS = Number(process.env.SCHEDULE_MAX_JOBS ?? DEFAULT_SWEEP_CAP);
/** Give the worker a moment after a co-ordinated restart before handing it work. */
const STARTUP_DELAY_MS = Number(process.env.SCHEDULE_STARTUP_DELAY_MS ?? 30_000);

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (message: string): void => console.log(`scheduler: ${stamp()} ${message}`);

async function tick(): Promise<void> {
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
    maxJobs: MAX_JOBS,
    refreshList: true,
    supportedOnly: true,
    latestFirst: true,
    source: "schedule",
  });
  log(`queued a sweep (${cmd.id}): refresh the list, then up to ${MAX_JOBS} application(s)`);
}

async function main(): Promise<void> {
  log(`started — every ${Math.round(EVERY_MS / 60000)} min, up to ${MAX_JOBS} job(s) per sweep`);
  if (STARTUP_DELAY_MS > 0) {
    log(`waiting ${Math.round(STARTUP_DELAY_MS / 1000)}s before the first tick`);
    await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));
  }
  await tick().catch((error) => log(`tick failed: ${(error as Error).message}`));
  setInterval(() => {
    void tick().catch((error) => log(`tick failed: ${(error as Error).message}`));
  }, EVERY_MS);
}

void main();
