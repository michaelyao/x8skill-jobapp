import { buildJobIdentity } from "./jobIdentity.js";
import { hasAppliedBefore, hasSubmittedBefore, loadApplications } from "../knowledge/applications.js";
import { loadInternshipList } from "../sources/internshipList.js";
import type { FilteredJob } from "../types.js";

/**
 * Choose which jobs to apply to next. NO BROWSER, and that is the point.
 *
 * This is everything the old fill run did between "read the CSV" and "open Chrome": filter,
 * order, and check each candidate against the ledger. It is pure file and CPU work, so it can
 * run anywhere — including inside the website container, which has no browser in it.
 *
 * It decides, it does not act. The caller turns each choice into one `apply` command, and the
 * worker drains those one at a time through the single Chrome profile. That queue is the whole
 * pacing mechanism: a sweep that picks ten jobs never means ten browsers.
 */

/** How many jobs one sweep will start. Chosen deliberately low — see SweepPlan. */
export const DEFAULT_SWEEP_CAP = 10;

/**
 * The ATS families a driver can actually fill. A listing that fails this is kept in the list and
 * counted, never applied to — there is no adapter to drive it.
 *
 * Workable is in: single-page form, verified live. Oracle HCM is opt-in behind ORACLE_ATS=1 — the
 * driver works up to an authentication gate that would create a candidate profile at the employer
 * (see oracle.ts), so it stops there rather than deciding that on its own.
 *
 * SmartRecruiters is deliberately ABSENT and should not be added without a plan. Its apply flow
 * sits behind DataDome: on the first automated attempt it served a CAPTCHA and returned "Access is
 * temporarily restricted — we detected unusual activity from your device or network", naming the
 * IP. CLAUDE.md's rule is to never try to defeat an explicit CAPTCHA, and retrying only worsens
 * the reputation of an IP the rest of the run depends on. 9 roles are not worth that.
 */
const SUPPORTED_ATS = /myworkdayjobs\.com|\.wd[0-9]\.|ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com/i;
const ORACLE_ATS = /oraclecloud\.com.*candidateexperience/i;

export interface SelectOptions {
  /** Only these CSV codes, if given. */
  jobIds?: string[];
  /** Stop after this many selectable jobs. Defaults to DEFAULT_SWEEP_CAP. */
  maxJobs?: number;
  /** Skip anything on an ATS we cannot drive. */
  supportedOnly?: boolean;
  /** Freshest postings first. */
  latestFirst?: boolean;
  /**
   * Re-open a job the ledger already holds. A run that stopped blocked is recorded
   * "prefilled_pending_submit", which otherwise skips it forever — so a fix to the form
   * handling could never reach the jobs it was written for. It deliberately does NOT override
   * a job that was actually submitted; that would duplicate an application.
   */
  forceRetry?: boolean;
}

export interface Skipped {
  code?: string;
  company: string;
  reason: string;
}

export interface SweepPlan {
  /** Jobs to apply to, in order, capped. */
  selected: FilteredJob[];
  /** Why each candidate was passed over — surfaced so a sweep that picks nothing says why. */
  skipped: Skipped[];
  /** Candidates in the list before any filtering. */
  considered: number;
  /** Selectable jobs that did not fit under the cap. */
  heldBackByCap: number;
}

/**
 * Freshness order for the CSV "Posted" column: "0d".."30d" are day counts and sort first,
 * "1mo" next, explicit dates after that, blank last.
 */
function freshOrder(age: string): number {
  const a = (age || "").trim();
  const m = a.match(/^(\d+)d$/);
  if (m) return Number(m[1]);
  if (/^1mo$/i.test(a)) return 40;
  return a ? 60 : 99;
}

export async function planSweep(opts: SelectOptions = {}): Promise<SweepPlan> {
  const cap = opts.maxJobs && opts.maxJobs > 0 ? opts.maxJobs : DEFAULT_SWEEP_CAP;
  const applications = await loadApplications();

  let candidates = await loadInternshipList();
  const considered = candidates.length;

  const wanted = (opts.jobIds ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean);
  if (wanted.length) {
    candidates = candidates.filter((job) => job.id && wanted.includes(job.id.toUpperCase()));
  }
  if (opts.supportedOnly) {
    candidates = candidates.filter(
      (job) =>
        SUPPORTED_ATS.test(job.applyUrl) ||
        (process.env.ORACLE_ATS === "1" && ORACLE_ATS.test(job.applyUrl)),
    );
  }
  if (opts.latestFirst) {
    candidates = [...candidates].sort((x, y) => freshOrder(x.age) - freshOrder(y.age));
  }

  const selected: FilteredJob[] = [];
  const skipped: Skipped[] = [];
  let heldBackByCap = 0;

  for (const job of candidates) {
    const identity = buildJobIdentity(job);

    // The ledger is the only dedupe source now. The Google tracker sheet used to be a second
    // one, but reading it needed a browser AND a human to press Enter, which cannot work on a
    // schedule. applications.json matches on requisition id, identityKey, externalJobId and
    // normalized apply URL — four redundant routes, none of which need a session.
    const engaged = hasAppliedBefore(applications, identity);
    const submitted = hasSubmittedBefore(applications, identity);

    if (submitted) {
      // No override reaches this branch. Re-applying cannot be undone.
      skipped.push({ code: job.id, company: job.company, reason: "already submitted" });
      continue;
    }
    if (engaged && !opts.forceRetry) {
      skipped.push({ code: job.id, company: job.company, reason: "already in the ledger" });
      continue;
    }

    // Cap AFTER the dedupe checks, so the cap counts jobs we would really open rather than
    // being eaten by a run of already-done ones.
    if (selected.length >= cap) {
      heldBackByCap += 1;
      continue;
    }
    selected.push(job);
  }

  return { selected, skipped, considered, heldBackByCap };
}
