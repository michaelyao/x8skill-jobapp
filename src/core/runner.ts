import { enqueueCommand } from "../knowledge/commands.js";
import { DEFAULT_SWEEP_CAP, planSweep } from "./selectJobs.js";
import { isStale, readWorkerStatus } from "../knowledge/workerStatus.js";

/**
 * `npm start` — ask the worker to apply to the next batch of jobs.
 *
 * This used to BE the fill run: it launched its own Chrome against the persistent profile and
 * worked through the list itself. That is exactly one browser too many. The worker owns Chrome
 * and takes the lock; nothing here took it, so a hand-run `npm start` could open a second
 * Chrome on the same user-data-dir while the worker was mid-application — the same class of
 * collision as two workers, minus the orphan.
 *
 * So this is a client now, like the website and ./bin/jobapp. It plans the batch (pure file
 * work — no browser), enqueues one `apply` per job, and exits. The worker drains them ONE AT A
 * TIME, so ten queued applications never mean ten Chromes, and a decision you make meanwhile
 * outranks all of them.
 *
 * Env, all optional:
 *   MAX_JOBS=3        cap this batch (default 10)
 *   JOB_ID=A,B        only these CSV codes
 *   SKIP_REFRESH=1    do not rebuild the job list first
 *   SUPPORTED_ONLY=1  only ATS we can drive
 *   LATEST_FIRST=1    freshest postings first
 *   FORCE_RETRY=1     re-open jobs already in the ledger (never ones already submitted)
 */
export async function run(): Promise<void> {
  const maxJobs = positiveInt(process.env.MAX_JOBS) ?? DEFAULT_SWEEP_CAP;
  const jobIds = (process.env.JOB_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  const refreshList = process.env.SKIP_REFRESH !== "1";

  const worker = await readWorkerStatus();
  if (!worker || isStale(worker)) {
    // Without the worker nothing drains the queue, and silently enqueuing would look like
    // success while nothing happened.
    console.error("The worker is not running, so nothing would execute these.");
    console.error("Start it with:  ./worker-start.sh    (or: launchctl kickstart gui/$(id -u)/com.studiox8.jobapp.worker)");
    process.exitCode = 1;
    return;
  }

  // Plan here purely to report it. The worker re-plans when it runs the sweep, because the
  // ledger may have moved on by then — this is a preview, not the decision.
  const plan = await planSweep({
    jobIds,
    maxJobs,
    supportedOnly: process.env.SUPPORTED_ONLY === "1",
    latestFirst: process.env.LATEST_FIRST === "1",
    forceRetry: process.env.FORCE_RETRY === "1",
  });

  console.log(`${plan.considered} listing(s) in the job list.`);
  const why = new Map<string, number>();
  for (const s of plan.skipped) why.set(s.reason, (why.get(s.reason) ?? 0) + 1);
  for (const [reason, n] of why) console.log(`  ${n} skipped — ${reason}`);
  if (plan.heldBackByCap) console.log(`  ${plan.heldBackByCap} held back by the cap of ${maxJobs}`);

  if (!plan.selected.length) {
    console.log("\nNothing to apply to right now.");
    return;
  }

  console.log(`\nQueueing ${plan.selected.length} application(s):`);
  for (const job of plan.selected) {
    console.log(`  ${job.id ?? "----"}  ${job.company} — ${job.title}`);
  }

  const cmd = await enqueueCommand({
    name: "sweep",
    jobIds,
    maxJobs,
    refreshList,
    supportedOnly: process.env.SUPPORTED_ONLY === "1",
    latestFirst: process.env.LATEST_FIRST === "1",
    forceRetry: process.env.FORCE_RETRY === "1",
    source: "cli",
  });

  console.log(`\nSweep queued (${cmd.id}).${refreshList ? " The job list is rebuilt first." : ""}`);
  console.log("The worker applies to them one at a time. Watch it with:");
  console.log("  ./bin/jobapp status        tail -f logs/worker.log");
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}
