import { enqueueCommand, pendingCommands } from "./commands.js";
import { listAwaiting, markReplyProcessed, type PendingEntry } from "./approvalQueue.js";
import { checkApprovalOnce, codesWithReplies, type ReviewData } from "./reviewEmail.js";

/**
 * Turn email replies into commands.
 *
 * The email path used to be a whole second executor: it launched its own Chrome, re-filled
 * the form and submitted, in parallel with the daemon that already owns the browser. Two
 * drivers coordinated by a lock file is not coordination, it is taking turns — and the guard
 * sequence that stops a double submit had already been copied and had already drifted.
 *
 * So this does not act. It reads the inbox and ENQUEUES the same commands the console and the
 * CLI enqueue, and the worker executes them in one lane with one set of guards.
 *
 * Nothing here decides what a reply means: `checkApprovalOnce` owns attribution (by unique
 * code only, never company name) and the SENT-but-not-"Re:" rule that keeps our own outgoing
 * review from being read as an approval of itself.
 */

const reviewDataFor = (entry: PendingEntry): ReviewData => ({
  company: entry.company,
  title: entry.title,
  code: entry.code,
  applyUrl: entry.applyUrl,
  jobDescription: entry.jobDescription ?? "",
  filledFields: entry.filledFields ?? [],
});

export interface EmailScanResult {
  candidates: number; // queued jobs whose thread has a reply at all
  enqueued: Array<{ code: string; decision: "approved" | "skip" | "change"; command: string }>;
  notes: string[];
}

export async function scanEmailForDecisions(): Promise<EmailScanResult> {
  const result: EmailScanResult = { candidates: 0, enqueued: [], notes: [] };

  // Only awaiting_approval entries are ever considered — a submitted job cannot be revived by
  // an old reply, which is the first of the anti-double-submit layers.
  const awaiting = await listAwaiting();
  if (!awaiting.length) return result;

  const replied = await codesWithReplies();
  const candidates = awaiting.filter((e) => e.code && replied.has(e.code.toUpperCase()));
  result.candidates = candidates.length;
  if (!candidates.length) return result;

  const alreadyQueued = new Set(
    (await pendingCommands()).map((c) => ("code" in c && c.code ? String(c.code).toUpperCase() : "")).filter(Boolean),
  );

  for (const entry of candidates) {
    const code = entry.code!.toUpperCase();
    // A command for this job is already waiting; enqueueing a second one from the same reply
    // is exactly the duplicate this scan must not create.
    if (alreadyQueued.has(code)) {
      result.notes.push(`${code}: a command is already queued — leaving the reply for the next scan`);
      continue;
    }

    const reply = await checkApprovalOnce(reviewDataFor(entry), { ignoreIds: entry.processedReplyIds });
    if (reply.decision === "none" || !reply.messageId) continue;

    // Mark BEFORE enqueueing. If this process dies in between, the approval is lost and you
    // must reply again — annoying. The other order risks enqueueing the same approval twice,
    // which risks submitting twice. Losing an approval is recoverable; a duplicate is not.
    await markReplyProcessed(entry.key, reply.messageId);

    if (reply.decision === "approved") {
      const cmd = await enqueueCommand({ name: "approve", code, source: "email", actor: "email" } as never);
      result.enqueued.push({ code, decision: "approved", command: cmd.id });
    } else if (reply.decision === "skip") {
      const cmd = await enqueueCommand({ name: "skip", code, source: "email", actor: "email" } as never);
      result.enqueued.push({ code, decision: "skip", command: cmd.id });
    } else if (reply.decision === "change") {
      const instruction = (reply.changeText ?? "").trim();
      if (!instruction) {
        result.notes.push(`${code}: change requested but the reply had no instruction text`);
        continue;
      }
      const cmd = await enqueueCommand({ name: "change", code, instruction, source: "email", actor: "email" } as never);
      result.enqueued.push({ code, decision: "change", command: cmd.id });
    }
  }

  return result;
}
