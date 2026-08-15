import { applyToJob, type ApplyDeps } from "./applyJob.js";
import { buildJobIdentity } from "./jobIdentity.js";
import { hasSubmittedBefore } from "../knowledge/applications.js";
import { updatePendingStatus, type PendingEntry } from "../knowledge/approvalQueue.js";
import { ReplayAgent } from "../agent/replayAgent.js";
import { describeDiff, diffRounds, listRounds } from "../knowledge/rounds.js";
import type { FilledAnswer } from "../agent/types.js";
import type { AnswerEntry, ApplicationRecord, FilteredJob } from "../types.js";

export const MAX_SUBMIT_ATTEMPTS = 3;

/** Rebuild a FilteredJob from a queued entry — a days-old posting may have aged out of the CSV. */
export function jobFromEntry(entry: PendingEntry): FilteredJob {
  return {
    company: entry.company,
    title: entry.title,
    location: entry.location ?? "",
    age: "",
    applyUrl: entry.applyUrl,
    id: entry.code,
    region: entry.region,
    usEligible: true,
    needsManualLocationReview: false,
  };
}

export interface SubmitContext {
  answers: AnswerEntry[];
  applications: ApplicationRecord[];
  deps: ApplyDeps;
}

export interface SubmitOutcome {
  result: "submitted" | "already_submitted" | "will_retry" | "gave_up";
  message: string;
  answers: AnswerEntry[];
  applications: ApplicationRecord[];
}

/**
 * Submit ONE approved application, with the full guard sequence. Shared by the email poller
 * and the web console's worker so the two can never drift apart — these guards are the only
 * thing standing between an approval and a duplicate application, and a second copy of them
 * would eventually diverge.
 *
 * `replayAnswers` is what actually gets typed into the form. When the console sends edited
 * answers they arrive here, which is why "submitted == approved" still holds after an edit:
 * the edit happens before approval, and no LLM runs on this path.
 */
export async function submitApprovedEntry(
  entry: PendingEntry,
  ctx: SubmitContext,
  opts: { replayAnswers?: FilledAnswer[]; note: string; onSubmitted?: () => Promise<void> },
): Promise<SubmitOutcome> {
  const label = entry.code ?? entry.key;
  const job = jobFromEntry(entry);
  const identity = buildJobIdentity(job);
  let { answers, applications } = ctx;

  // The queue and the ledger are written separately, so if they disagree the ledger's
  // "submitted" wins. Re-submitting is not undoable; waiting is.
  if (hasSubmittedBefore(applications, identity)) {
    await updatePendingStatus(entry.key, "submitted", { lastError: "already submitted per local ledger" });
    await opts.onSubmitted?.();
    return {
      result: "already_submitted",
      message: `[${label}] the ledger already records this as submitted — not submitting again`,
      answers,
      applications,
    };
  }

  // Write-ahead marker: if this process dies after the click but before the outcome is
  // recorded, the entry stays "submitting", is excluded from listAwaiting(), and is never
  // auto-retried — it is reported for manual confirmation instead.
  const attempts = (entry.attempts ?? 0) + 1;
  await updatePendingStatus(entry.key, "submitting", { attempts });

  const replayAgent = new ReplayAgent(opts.replayAnswers ?? entry.answers ?? []);
  const outcome = await applyToJob(job, identity, answers, applications, ctx.deps, {
    mode: "submit",
    interactive: false,
    graceMs: 0,
    replayAnswers: opts.replayAnswers ?? entry.answers ?? [],
    replayAgent,
    baseNotes: [opts.note],
  });
  answers = outcome.answers;
  applications = outcome.applications;

  if (outcome.submitted) {
    await updatePendingStatus(entry.key, "submitted", { attempts });
    await opts.onSubmitted?.();
    return { result: "submitted", message: `[${label}] submitted`, answers, applications };
  }
  if (outcome.alreadyApplied) {
    await updatePendingStatus(entry.key, "submitted", { attempts, lastError: "already applied on site" });
    await opts.onSubmitted?.();
    return { result: "already_submitted", message: `[${label}] already applied on site`, answers, applications };
  }

  // Nothing was submitted, so it is safe to hand back to the queue: reset to awaiting
  // (clearing the write-ahead marker) so the same approval can drive a retry, up to a cap.
  // Distinguish "the form changed since you approved it" from a generic stall: a required
  // question the approved answers do not cover cannot be resolved by retrying, it needs a
  // re-fill and a fresh review.
  const drifted = replayAgent.unmatchedRequired;
  // Cite the recorded evidence rather than an interpretation: the round saved when the user
  // approved, against the round just saved for this attempt. If they are identical, say so —
  // that means the fault is ours, not the form's.
  let evidence = "";
  if (drifted.length && entry.code) {
    const rounds = await listRounds(entry.code);
    const current = [...rounds].reverse().find((r) => r.phase === "submit");
    const approved = [...rounds].reverse().find((r) => r.phase !== "submit");
    if (approved && current) {
      const lines = describeDiff(diffRounds(approved, current));
      evidence = lines.length
        ? ` Form differences since ${approved.at}: ${lines.slice(0, 4).join(" | ")}${lines.length > 4 ? ` (+${lines.length - 4} more)` : ""}.`
        : ` The form is UNCHANGED since ${approved.at} — so this is a fault in the replay, not the posting.`;
    }
  }
  const why = outcome.reachedReview
    ? "submit control not found"
    : drifted.length
      ? `${drifted.length} required question(s) have no approved answer: ${drifted.slice(0, 3).join("; ")}${drifted.length > 3 ? ` (+${drifted.length - 3})` : ""}.${evidence}`
      : `did not reach review on replay${outcome.blockedRequired?.length ? ` (blocked: ${outcome.blockedRequired.join("; ")})` : ""}`;
  const giveUp = attempts >= MAX_SUBMIT_ATTEMPTS;
  await updatePendingStatus(entry.key, giveUp ? "error" : "awaiting_approval", { attempts, lastError: why });
  return {
    result: giveUp ? "gave_up" : "will_retry",
    message: `[${label}] not submitted (attempt ${attempts}/${MAX_SUBMIT_ATTEMPTS}): ${why}`,
    answers,
    applications,
  };
}
