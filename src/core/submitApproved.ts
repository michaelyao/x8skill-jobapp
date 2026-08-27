import { applyToJob, type ApplyDeps } from "./applyJob.js";
import { buildJobIdentity } from "./jobIdentity.js";
import { hasSubmittedBefore } from "../knowledge/applications.js";
import { setVisualCheck, updatePendingStatus, type PendingEntry } from "../knowledge/approvalQueue.js";
import { ReplayAgent } from "../agent/replayAgent.js";
import { describeDiff, diffRounds, listRounds } from "../knowledge/rounds.js";
import { describeProblems, reviewApplication } from "./applicationSanity.js";
import { parseResumeHistory } from "../knowledge/resumeHistory.js";
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
  result: "submitted" | "already_submitted" | "will_retry" | "gave_up" | "held_for_reapproval";
  message: string;
  answers: AnswerEntry[];
  applications: ApplicationRecord[];
}

/**
 * Submit ONE approved application, with the full guard sequence. Shared by the email poller
 * and the web website's worker so the two can never drift apart — these guards are the only
 * thing standing between an approval and a duplicate application, and a second copy of them
 * would eventually diverge.
 *
 * `replayAnswers` is what actually gets typed into the form. When the website sends edited
 * answers they arrive here, which is why "submitted == approved" still holds after an edit:
 * the edit happens before approval, and no LLM runs on this path.
 */
/**
 * How long an approved entry waits for an outstanding visual cross-check before giving up on
 * it. Generous relative to the measured 1.6-56s so a slow provider still gets its verdict in,
 * short enough that a lost x8ocr job (in-memory, does not survive a restart) cannot park an
 * application indefinitely.
 */
const VISUAL_CHECK_GRACE_MS = Number(process.env.VISUAL_CHECK_GRACE_MS || 10 * 60_000);

export async function submitApprovedEntry(
  entry: PendingEntry,
  ctx: SubmitContext,
  opts: {
    replayAnswers?: FilledAnswer[];
    note: string;
    onSubmitted?: () => Promise<void>;
    /** Re-fill the live form and verify it against the approved answers before submitting.
     *  Default. Pass false to replay blind (kept for a deliberate, exact re-run). */
    refill?: boolean;
  },
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

  /**
   * Re-check the QUEUED CONTENT before sending it, whenever it was filled.
   *
   * The whole-application guardrail runs during a fill, so it protects applications filled after it
   * existed and says nothing about the fifty already sitting in the queue. `npm run audit:queue`
   * found nine of those that would now be refused — a GPA band of "3.0 -3.5" against a real 3.53, an
   * application with no email address, several with School and Degree blank.
   *
   * Re-filling them was not enough, and that is the point of checking here. A re-fill that FAILS
   * ("did not reach review", "still blocked on <required field>") leaves the old entry untouched
   * and still `awaiting_approval` — seven of the nine ended exactly that way, approvable, holding
   * the same incomplete content the audit had just condemned. Marking the entry on every failure
   * path would be both fiddly and wrong (a network failure says nothing about the queued copy).
   *
   * So the question is asked where it actually matters: not "did the last fill go well?" but "is
   * the thing we are about to send acceptable?". This is the one place every send passes through,
   * it needs no new status, and it covers entries filled long before any of these checks existed.
   *
   * Facts only — no `history` or `documents`, which were never recorded for older entries and
   * whose absence must not be read as a fault.
   */
  // The queue entry holds the answers; the field list lives on the last recorded round, which is
  // what makes "the form asked for education and it is blank" answerable here at all.
  const rounds = await listRounds(entry.code ?? entry.key).catch(() => []);
  const lastRound = rounds[rounds.length - 1];
  const edu = parseResumeHistory(ctx.deps.profile.resumeText || ctx.deps.profile.rawText || "").education[0];
  const stale = reviewApplication({
    answers: (entry.answers ?? []).map((a) => ({ label: a.label, value: a.value, type: "text" as const })),
    observedFields: (lastRound?.fields ?? []).map((f) => ({
      key: f.label,
      label: f.label,
      type: "text" as const,
      required: f.required,
      options: f.options,
    })),
    resumeAttached: true,
    facts: { degree: edu?.degree, fieldOfStudy: edu?.fieldOfStudy, gpa: ctx.deps.profile.gpa ?? edu?.gpa },
  });
  if (stale.length) {
    await updatePendingStatus(entry.key, "error", { lastError: `incomplete: ${describeProblems(stale)}` });
    return {
      result: "gave_up",
      message:
        `[${label}] NOT submitting — the queued application is incomplete:\n` +
        `${stale.map((p) => `     • ${p.message}`).join("\n")}\n` +
        `     Re-fill it (./bin/jobapp retry ${label}); approving it again will not change this.`,
      answers,
      applications,
    };
  }

  /**
   * The visual cross-check gate.
   *
   * The fill run no longer waits for OCR, so an entry can be approved before the screen has
   * been verified. This is the one place every send passes through, so it is where that gap is
   * closed: refuse while the verdict is outstanding, and refuse outright when the screen
   * disagreed with what we recorded.
   *
   * A "pending" that never resolves must not strand the application forever — x8ocr holds jobs
   * in memory and a restart loses them. After VISUAL_CHECK_GRACE_MS it ages out and is treated
   * as unavailable, which is exactly how a missing OCR result has always been treated: it says
   * nothing rather than blaming the application.
   */
  const vc = entry.visualCheck;
  if (vc?.state === "gaps") {
    await updatePendingStatus(entry.key, "error", {
      lastError: `the screen did not match what was recorded: ${(vc.gaps ?? []).join("; ")}`,
    });
    return {
      result: "gave_up",
      message: `[${label}] NOT submitting — the review screen did not match what was recorded:\n${(vc.gaps ?? []).map((g) => `     • ${g}`).join("\n")}\n     Re-fill it (./bin/jobapp retry ${label}) rather than approving it again.`,
      answers,
      applications,
    };
  }
  if (vc?.state === "pending") {
    const waited = Date.now() - Date.parse(vc.at);
    if (Number.isFinite(waited) && waited < VISUAL_CHECK_GRACE_MS) {
      return {
        result: "will_retry",
        message: `[${label}] waiting on the visual cross-check (x8ocr job ${vc.jobId ?? "?"}, ${Math.round(waited / 1000)}s) — still queued, it will submit once the screen is verified`,
        answers,
        applications,
      };
    }
    // Aged out. Proceed exactly as if OCR had never been available.
    await setVisualCheck(entry.key, { state: "unavailable", jobId: vc.jobId, at: new Date().toISOString() });
  }

  // Write-ahead marker: if this process dies after the click but before the outcome is
  // recorded, the entry stays "submitting", is excluded from listAwaiting(), and is never
  // auto-retried — it is reported for manual confirmation instead.
  const attempts = (entry.attempts ?? 0) + 1;
  await updatePendingStatus(entry.key, "submitting", { attempts });

  const approvedAnswers = opts.replayAnswers ?? entry.answers ?? [];
  const refill = opts.refill !== false;
  const replayAgent = new ReplayAgent(approvedAnswers);
  const runSubmit = () =>
    applyToJob(job, identity, answers, applications, ctx.deps, {
      mode: "submit",
      interactive: false,
      replayAnswers: approvedAnswers,
      refillOnSubmit: refill,
      replayAgent,
      baseNotes: [opts.note],
    });

  let outcome: Awaited<ReturnType<typeof applyToJob>>;
  try {
    outcome = await runSubmit();
  } catch (error) {
    // The write-ahead marker exists for an outcome we cannot know. A failure to even open a page
    // is not that: no form was touched, so the entry goes back to the queue instead of being
    // reported as possibly-submitted. Anything else keeps the marker and asks for a human.
    const message = (error as Error).message.split("\n")[0];
    const neverOpened = /Target page, context or browser has been closed|browserContext\.newPage|browser has been closed/i.test(message);
    await updatePendingStatus(entry.key, neverOpened ? "awaiting_approval" : "submitting", {
      attempts,
      lastError: neverOpened ? `no browser — nothing was opened or submitted (${message})` : message,
    });
    return {
      result: neverOpened ? "will_retry" : "gave_up",
      message: `[${label}] ${neverOpened ? "could not start: no usable browser — nothing was submitted, still queued" : `failed mid-submit: ${message}`}`,
      answers,
      applications,
    };
  }

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

  // Re-filled, but the form no longer produces what was approved. Nothing was submitted and
  // nothing is retried: a retry would re-derive the same differences. It goes back to the queue
  // carrying BOTH copies, and only a fresh approval of the new values can move it.
  if (outcome.heldForReapproval) {
    const { reasons, answers: proposed } = outcome.heldForReapproval;
    await updatePendingStatus(entry.key, "awaiting_approval", {
      attempts,
      lastError: `held for re-approval: ${reasons.slice(0, 2).join("; ")}${reasons.length > 2 ? ` (+${reasons.length - 2} more)` : ""}`,
      reapproval: { at: new Date().toISOString(), reasons, proposed, previous: approvedAnswers },
    });
    return {
      result: "held_for_reapproval",
      message: `[${label}] NOT submitted — the form no longer matches what you approved (${reasons.length} difference${reasons.length === 1 ? "" : "s"}). Review it again in the website.`,
      answers,
      applications,
    };
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
