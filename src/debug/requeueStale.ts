import { loadApplications } from "../knowledge/applications.js";
import { enqueueCommand, pendingCommands } from "../knowledge/commands.js";
import { isSubmittedStatus, loadPendingQueue } from "../knowledge/approvalQueue.js";
import type { PendingEntry } from "../knowledge/approvalQueue.js";

/**
 * RE-RUN EVERY STALE APPLICATION, NEWEST FIRST, UNTIL IT CAN BE SUBMITTED.
 *
 *   npx tsx src/debug/requeueStale.ts [--limit N] [--dry]
 *
 * The candidate's instruction, and it is the right one: a record sitting at "failed — will be
 * retried" helps nobody. Either it reaches Review and lands in his queue where he can submit it,
 * or he dismisses it. Buried in a log is neither.
 *
 * Ordered NEWEST FIRST on purpose. The oldest failures are the ones most likely to be closed
 * postings by now, and the newest are both the most applicable and the most likely to have failed
 * for a cause that has since been fixed — 240 records against a sweep that takes ten every eight
 * hours is eight days, and most of what is in there is stale rather than broken.
 *
 * WHAT IT SKIPS, and why each is not a failure to retry:
 *   - anything already submitted, by us or by hand — re-opening a live application is the one
 *     unrecoverable mistake here
 *   - `expired`: the posting is gone
 *   - anything already sitting in the approval queue awaiting a decision, or mid-submit
 *   - anything already queued as a command, so running this twice does not double the work
 *
 * Rank 2 (the default for a re-fill) is deliberate: these are background work and must never sit
 * in front of an approve, a skip, or a visual check. The candidate's decisions still jump the queue
 * while this grinds.
 */
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Number.POSITIVE_INFINITY;
const dry = process.argv.includes("--dry");

const applications = await loadApplications();
const queue: PendingEntry[] = await loadPendingQueue();
const byCode = new Map<string, PendingEntry>(queue.map((e) => [e.code, e] as [string, PendingEntry]));
const alreadyQueued = new Set(
  (await pendingCommands()).map((c) => (c as { code?: string }).code).filter(Boolean) as string[],
);

const stale = applications
  /**
   * "Stale" is anything the candidate cannot act on: a run that FAILED, and — the case he found
   * himself — a run that FINISHED and was never queued. CDRDUK (Johnson & Johnson) reached Review
   * on 6 September, recorded prefilled_pending_submit, and had no queue entry at all, so
   * /applications showed it as done while /queue had nothing. Ten were in that state going back to
   * 27 August. A finished application nobody can see is worse than a failed one.
   */
  .filter(
    (a) =>
      a.status === "error" ||
      (a.status === "prefilled_pending_submit" && !(a.code && byCode.has(a.code))),
  )
  .filter((a) => {
    const entry = a.code ? byCode.get(a.code) : undefined;
    if (entry && isSubmittedStatus(entry.status)) return false;
    if (entry && (entry.status === "submitting" || entry.status === "expired")) return false;
    // Awaiting a decision is not stale — it is waiting on a person, and re-filling would replace
    // the copy he is reading.
    if (entry && entry.status === "awaiting_approval") return false;
    if (a.code && alreadyQueued.has(a.code)) return false;
    return Boolean(a.code);
  })
  .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

const take = stale.slice(0, Number.isFinite(limit) ? limit : stale.length);
console.log(
  `  ${applications.filter((a) => a.status === "error").length} records say "failed"; ${stale.length} are worth re-running; taking ${take.length}`,
);
if (take.length) {
  console.log(`  newest: ${take[0]?.code} ${String(take[0]?.updatedAt).slice(0, 19)}`);
  console.log(`  oldest: ${take[take.length - 1]?.code} ${String(take[take.length - 1]?.updatedAt).slice(0, 19)}`);
}
if (dry) {
  console.log("  --dry: nothing queued");
  process.exit(0);
}

let queued = 0;
for (const app of take) {
  await enqueueCommand({
    name: "retry",
    code: app.code!,
    source: "cli",
    actor: "requeue-stale",
    instruction: "re-run on current code until it reaches review and can be submitted",
  } as never);
  queued += 1;
}
console.log(`  queued ${queued} re-fill(s), newest first. Decisions still outrank them.`);
