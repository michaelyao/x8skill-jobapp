import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { reviewApplication } from "./applicationSanity.js";
import { parseResumeHistory } from "../knowledge/resumeHistory.js";
import { isSubmittedStatus, type PendingEntry } from "../knowledge/approvalQueue.js";
import { normalizeUrl } from "../utils/normalize.js";
import type { FieldSpec, FilledAnswer } from "../agent/types.js";
import type { ProfileData } from "../types.js";

/**
 * Is a queued application READY FOR REVIEW, or does it still need work?
 *
 * "Awaiting approval" was doing two jobs at once: an application that is finished and waiting on a
 * human, and one that reached review with something missing. Both showed on /queue as though they
 * were ready, which is how an application with eleven unanswered required fields sat there looking
 * like a decision waiting to be made.
 *
 * The distinction is not a new status — it is the guardrail's own answer, computed on read. Same
 * function for the website and for `npm run audit:queue`, so the list you look at and the report
 * you run can never disagree, and neither can drift from what submitApprovedEntry will actually
 * refuse.
 *
 * READ-ONLY. It writes nothing: the worker is the only writer of application state, and a display
 * decision must not become a state change.
 */

export interface Readiness {
  entry: PendingEntry;
  /** Empty when the application is ready for a human to review. */
  problems: string[];
  /** Set when this was approved before and came back because the submit failed. */
  previouslyApproved?: { by?: string; at?: string; failure?: string };
}

/** Facts the checks compare stated answers against. */
export function resumeFactsFrom(profile: ProfileData): {
  degree?: string;
  fieldOfStudy?: string;
  gpa?: string;
} {
  const edu = parseResumeHistory(profile.resumeText || profile.rawText || "").education[0];
  return { degree: edu?.degree, fieldOfStudy: edu?.fieldOfStudy, gpa: profile.gpa ?? edu?.gpa };
}

interface RoundFile {
  fields?: Array<{ label: string; type?: string; required?: boolean; options?: string[] }>;
}

/**
 * The field list from the newest round for a code. Only the NEWEST is read — the fields describe
 * the form, and a page render should not pay for every historical round.
 */
function newestFields(code: string): FieldSpec[] {
  const dir = path.join(DATA_DIR, "rounds", code);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      /* skip */
    }
  }
  if (!best) return [];
  try {
    const data = JSON.parse(fs.readFileSync(best.file, "utf8")) as RoundFile;
    return (data.fields ?? []).map((f) => ({
      key: f.label,
      label: f.label,
      type: "text" as const,
      required: Boolean(f.required),
      options: f.options,
    }));
  } catch {
    return [];
  }
}

/**
 * Judge one queued entry.
 *
 * The ANSWERS come from the entry, never from the round: the entry holds what would actually be
 * submitted, and after a failed re-fill the newest round holds the failed attempt's answers
 * instead. Reading the round condemned nine complete applications once.
 *
 * `history` and `documents` are deliberately not passed — they were never recorded for older
 * entries, and their absence must not read as a fault.
 */
export function judgeEntry(entry: PendingEntry, facts: ReturnType<typeof resumeFactsFrom>): Readiness {
  const problems = reviewApplication({
    answers: (entry.answers ?? []).map((a) => ({
      label: a.label,
      value: a.value,
      type: "text" as const,
    })) as FilledAnswer[],
    observedFields: newestFields(entry.code ?? entry.key),
    /**
     * What the run actually attached, when it recorded it.
     *
     * `resumeAttached: true` used to be hardcoded and `documents` was not passed at all, so the
     * document checks could never fire — a required upload the form asked for and never got was
     * invisible to the page that calls an application "ready for review". Two of them were.
     *
     * Absent stays lenient: entries filled before this was recorded cannot be judged on it, and
     * inventing a fault for them would bury the real ones. Anything filled from now on can be.
     */
    documents: entry.documents,
    // The posting's own text, for the eligibility check — the only check here that is about the JOB
    // rather than about how well the form was filled.
    jobDescription: entry.jobDescription,
    resumeAttached: entry.documents ? entry.documents.attached.includes("resume") : true,
    facts,
  }).map((p) => p.message);

  // An outstanding or failed visual cross-check is also "not ready" — the submit guard refuses on
  // both, so showing them as reviewable would promise something that cannot happen yet.
  if (entry.visualCheck?.state === "gaps") {
    problems.push(...(entry.visualCheck.gaps ?? ["the review screen did not match what was recorded"]));
  }

  return { entry, problems, previouslyApproved: priorApproval(entry) };
}

/**
 * An entry the user ALREADY approved, whose submit then failed and reset it to awaiting_approval.
 *
 * This is deliberate — only a genuine "nothing was submitted" outcome resets an entry, because the
 * alternative is never retrying a job whose submit died. But the queue showed it as an ordinary
 * item with no sign of any of that, so it reads as "why am I approving this again?". TXWZQB was
 * approved on 19 Aug, the browser context was dead so nothing was opened, and it came back looking
 * brand new. Saying so is the whole fix; the behaviour is correct.
 */
function priorApproval(entry: PendingEntry): { by?: string; at?: string; failure?: string } | undefined {
  if (!entry.decidedAt && !entry.approvedBy) return undefined;
  return { by: entry.approvedBy, at: entry.decidedAt, failure: entry.lastError };
}

export interface QueueSplit {
  /** Finished, checks pass — waiting on a human. */
  ready: Readiness[];
  /** Reached review but something is missing or wrong — needs a re-fill, not an approval. */
  needsWork: Readiness[];
}

export function splitQueue(
  entries: PendingEntry[],
  profile: ProfileData,
  /**
   * Every entry in the queue, not just the ones being split. A duplicate is only visible by
   * comparing against entries that have ALREADY been decided, and those are not in this list.
   */
  all: PendingEntry[] = entries,
): QueueSplit {
  const facts = resumeFactsFrom(profile);
  /**
   * THE SAME POSTING UNDER TWO CODES.
   *
   * MERPVQ and NNSRWS are both verkada/jobs/5210813007. NNSRWS was submitted; MERPVQ sat in the
   * queue as an ordinary item, so the page offered a decision on an application that had already
   * been filed — and approving it would have sent a second one to the same posting. The candidate
   * spotted it; nothing here did.
   *
   * Matched on the normalized apply URL, which is one of the four routes `sameJob()` already uses.
   */
  const submittedUrls = new Set(
    all
      .filter((e) => e.applyUrl && isSubmittedStatus(e.status))
      .map((e) => normalizeUrl(e.applyUrl!)),
  );
  const ready: Readiness[] = [];
  const needsWork: Readiness[] = [];
  for (const entry of entries) {
    const judged = judgeEntry(entry, facts);
    if (entry.applyUrl && submittedUrls.has(normalizeUrl(entry.applyUrl))) {
      judged.problems.unshift(
        "this is the SAME POSTING as an application already submitted — approving it would send a second one",
      );
    }
    (judged.problems.length ? needsWork : ready).push(judged);
  }
  return { ready, needsWork };
}
