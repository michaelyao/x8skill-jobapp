/**
 * ONE vocabulary for every stage an application can be in.
 *
 * There are two stores, and each has its own status enum: the LEDGER (one record per job, kept
 * forever) and the QUEUE (one entry per decision in flight, dropped once decided). They overlap
 * without agreeing — `skipped` against `skipped_existing`, `error` meaning different things in each
 * — and the website had THREE hand-written label maps on top. That is how the word "applied"
 * appeared in one table and nowhere else, reading like a confirmed fact when all it meant was that
 * a submit had been clicked.
 *
 * So the words live here, once, and the website, the CLI and the docs all read them. A label change
 * is a change in one place, and two pages cannot describe the same state differently.
 *
 * `confirmed` is deliberately ABSENT. Nothing yet reads the employer's acknowledgement, so there is
 * no honest way to display it; adding the word before the mechanism would be the same mistake as
 * "applied". When confirmation checking exists it belongs here as its own stage, never folded into
 * `submitted`.
 */
export type Tone = "good" | "accent" | "warn" | "bad" | "muted";

export interface StageWords {
  /** What to show in a table cell or a badge. Short. */
  label: string;
  /** One sentence a reviewer can act on. */
  meaning: string;
  tone: Tone;
  /** Did an application reach the employer? Absent means "not applicable". */
  wentIn?: boolean;
}

/** Ledger statuses — `ApplicationRecord.status`. One per job, permanent. */
export const LEDGER_STAGES: Record<string, StageWords> = {
  prefilled_pending_submit: {
    label: "filled, not sent",
    meaning: "The form was filled and left at the review step. Nothing was sent.",
    tone: "accent",
    wentIn: false,
  },
  submitted: {
    label: "submitted",
    meaning: "The submit control was clicked and the run reported success. The employer's confirmation is NOT checked.",
    tone: "good",
    wentIn: true,
  },
  manual_submitted: {
    label: "submitted by hand",
    meaning: "The candidate filled and submitted this himself on the employer's site.",
    tone: "good",
    wentIn: true,
  },
  already_applied_on_site: {
    label: "the ATS says already applied",
    meaning: "The employer's own site reported an existing application. This is their word, not ours.",
    tone: "good",
    wentIn: true,
  },
  skipped_existing: {
    label: "skipped",
    meaning: "Deliberately not applied for. No application exists.",
    tone: "muted",
    wentIn: false,
  },
  unsupported_ats: {
    label: "cannot apply",
    meaning: "No driver can fill this employer's form, so it was never opened.",
    tone: "muted",
    wentIn: false,
  },
  expired: {
    label: "posting closed",
    meaning: "The posting no longer exists. It will not be re-opened by a sweep.",
    tone: "muted",
    wentIn: false,
  },
  /**
   * A FAILED RUN IS NOT A CLOSED CASE, and the old wording said it was.
   *
   * "gave up — nothing sent / The run failed and stopped trying" reads as final, and the LEDGER's
   * error is the opposite: it is deliberately absent from ENGAGED_STATUSES, so the next sweep
   * picks the job up again. 201 postings sit here right now — most of them runs that stopped
   * before review and were wrongly filed as "filled" until tonight — and the candidate could not
   * tell from the page that they are queued to be retried rather than abandoned.
   *
   * The QUEUE's error is the final one (approved, submit failed three times, stopped); it keeps
   * its own wording below. Two stores, two meanings, which is the reason this module exists.
   */
  error: {
    label: "failed — will be retried",
    meaning: "The run stopped before the form was finished. Nothing was sent, and a later sweep will try this posting again.",
    tone: "warn",
    wentIn: false,
  },
};

/** Queue statuses — `PendingStatus`. One per decision in flight. */
export const QUEUE_STAGES: Record<string, StageWords> = {
  awaiting_approval: {
    label: "waiting for you",
    meaning: "Filled and checked. It needs your decision and will not be sent without it.",
    tone: "accent",
    wentIn: false,
  },
  submitting: {
    label: "submitting",
    meaning: "A submit is in flight, or one was clicked and the outcome never recorded — check the worker.",
    tone: "warn",
  },
  submitted: LEDGER_STAGES.submitted,
  manual_submitted: LEDGER_STAGES.manual_submitted,
  skipped: LEDGER_STAGES.skipped_existing,
  error: {
    label: "gave up — nothing sent",
    meaning: "Approved, but the submit failed three times and it stopped trying. Nothing was sent.",
    tone: "bad",
    wentIn: false,
  },
};

/** Visual cross-check states — `PendingEntry.visualCheck.state`. */
export const CHECK_STAGES: Record<string, StageWords> = {
  clean: { label: "screen matches", meaning: "Every recorded value was found in its own box on the review screenshot.", tone: "good" },
  gaps: { label: "screen disagrees", meaning: "The screenshot contradicts what was recorded, or shows a required question with no answer. A submit is refused.", tone: "bad" },
  pending: { label: "check running", meaning: "The screenshot has gone to x8ocr and the verdict has not come back yet.", tone: "warn" },
  unavailable: { label: "not checked", meaning: "The checker could not be reached, so this application was never verified visually.", tone: "warn" },
};

/**
 * Has this application been SENT? One question, asked in several places, and the answer must not be
 * spelled out per caller — that is how "applied" came to mean two things.
 *
 * `submitted` means we clicked and the run reported success. `manual_submitted` means the candidate
 * sent it by hand. `already_applied_on_site` is the employer's own word for it. Nothing else here
 * has reached an employer, and `prefilled_pending_submit` in particular has NOT — the form was
 * filled and left at the review step.
 */
export const SENT_STAGES: readonly string[] = ["submitted", "manual_submitted", "already_applied_on_site"];
export const wasSent = (status?: string): boolean => Boolean(status && SENT_STAGES.includes(status));

export const ledgerStage = (status?: string): StageWords | undefined => (status ? LEDGER_STAGES[status] : undefined);
export const queueStage = (status?: string): StageWords | undefined => (status ? QUEUE_STAGES[status] : undefined);
export const checkStage = (state?: string): StageWords | undefined => (state ? CHECK_STAGES[state] : undefined);
