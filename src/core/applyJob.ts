import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { AshbyDriver } from "../agent/drivers/ashby.js";
import { captureFormShot } from "../agent/formShot.js";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { LeverDriver } from "../agent/drivers/lever.js";
import { WorkableDriver } from "../agent/drivers/workable.js";
import { OracleDriver } from "../agent/drivers/oracle.js";
import { runApplication } from "../agent/turnLoop.js";
import { ReplayAgent } from "../agent/replayAgent.js";
import { HybridAgent } from "../agent/hybridAgent.js";
import { compareToApproved, describeDrift, type DriftReport } from "./approvalDrift.js";
import { describeProblems, reviewApplication } from "./applicationSanity.js";
import { parseResumeHistory } from "../knowledge/resumeHistory.js";
import { submitOcrJob } from "../knowledge/visualCheck.js";
import type { ResumeFacts } from "./factChecks.js";
import { addLearnedAnswer } from "../knowledge/answerStore.js";
import {
  classifyJobMatch,
  findCrossAtsDuplicate,
  recordApplication,
} from "../knowledge/applications.js";
import { loadPendingQueue, upsertPending, updatePendingStatus, type PendingEntry } from "../knowledge/approvalQueue.js";
import { resolveResumeForJob } from "../knowledge/resume.js";
import {
  fetchStoredJobDescription,
  findSimilarPostings,
  postApplicationNote,
  type X8NoteConfig,
} from "../knowledge/x8note.js";
import type { DuplicateWarning } from "../types.js";
import { saveRound } from "../knowledge/rounds.js";
import { findRequisitionId } from "./requisitionId.js";
import { withRequisitionId } from "./jobIdentity.js";
import { captureJobDescription, fetchGreenhouseJobDescription } from "../utils/jobDescription.js";
import { askUserForField, confirmSubmit } from "../utils/prompts.js";
import { normalizeQuestion, workdayEnglishUrl } from "../utils/normalize.js";
import type { Agent, AtsDriver, FilledAnswer } from "../agent/types.js";
import type {
  AnswerEntry,
  ApplicationRecord,
  FilteredJob,
  FormQuestion,
  JobIdentity,
  ProfileData,
  RunSummaryItem,
} from "../types.js";

/** The queue entry for this job, if a previous fill left one. */
/**
 * SCROLL EVERYTHING TO THE TOP BEFORE CAPTURING.
 *
 * `fullPage: true` captures the whole DOCUMENT, which is not the whole PAGE when the content sits
 * in a scrollable container: Workday's Review screen does, and the capture came out 6109px tall
 * STARTING AT "Education" — My Information and all three Work Experience rows simply absent. The
 * candidate said the screenshot only showed one experience; I checked the height, saw fullPage,
 * and told him scrolling would add nothing. He then asked "for the screenshot, you can scroll up
 * and take screenshot, right?", which is the fix.
 *
 * A review nobody can see the top of is not a review, and this is the artefact an approval is
 * given against.
 */
/**
 * A FAILED RUN MUST NOT LEAVE AN APPROVABLE COPY BEHIND.
 *
 * A previous fill may be sitting in the queue as awaiting_approval — which is exactly the case on
 * a re-fill, which is when a failure fires. Blocking the new attempt while leaving the old entry
 * approvable is the worst of both: the run says the application is not worth sending, and the
 * website still offers an Approve button for the older, equally incomplete copy.
 *
 * This existed for the "reached review but incomplete" path only. TMEIC stopped BEFORE review —
 * a different branch — so its 9-of-21-fields copy stayed approvable, and the candidate found it in
 * the queue and asked why he was being shown it. Both paths call this now.
 */
async function retireStaleQueuedCopy(key: string, why: string, code?: string): Promise<void> {
  const stale = await findPendingEntry(key);
  if (!stale || stale.status !== "awaiting_approval") return;
  await updatePendingStatus(stale.key, "error", { lastError: why });
  console.log(
    `     the queued copy of ${code ?? key} was still awaiting approval — marked error so it cannot be approved.`,
  );
}

async function scrollToTop(page: Page): Promise<void> {
  await page
    .evaluate(`(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
      // Any ancestor that scrolls its own content — the review panel is one of these.
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 4) el.scrollTop = 0;
      }
      return true;
    })()`)
    .catch(() => undefined);
  await page.waitForTimeout(250);
}

async function findPendingEntry(key: string) {
  return (await loadPendingQueue()).find((e) => e.key === key || e.code === key);
}

/**
 * The handful of resume facts the guardrail checks stated answers against. Parsed from the resume
 * rather than taken from the LLM, for the same reason the history sections are: these are facts.
 */
function resumeFacts(profile: ProfileData): ResumeFacts {
  const edu = parseResumeHistory(profile.resumeText || profile.rawText || "").education[0];
  return { degree: edu?.degree, fieldOfStudy: edu?.fieldOfStudy, gpa: profile.gpa ?? edu?.gpa };
}

const drivers: AtsDriver[] = [new WorkdayDriver(), new AshbyDriver(), new GreenhouseDriver(), new LeverDriver(), new WorkableDriver(), new OracleDriver()];

export interface ApplyDeps {
  context: BrowserContext;
  profile: ProfileData;
  agent: Agent;
  x8note: X8NoteConfig | null;
  runDir: string;
}

export interface ApplyOptions {
  /** "fill" = Phase A / change re-fill (LLM → email → short grace wait → queue).
   *  "submit" = Phase B clean approval (replay approved answers → submit, no email). */
  mode: "fill" | "submit";
  interactive: boolean;
  baseNotes?: string[];
  changeInstruction?: string; // "fill" mode: user's emailed correction to apply
  replayAnswers?: FilledAnswer[]; // "submit" mode: exact approved answers to replay
  /** A pre-built ReplayAgent, so the caller can read back which required fields it could not
   *  match — that is how "the form changed" is told apart from a generic stall. */
  replayAgent?: Agent;
  /** "submit" mode: re-fill the form and verify against the approved answers instead of
   *  replaying blind. See approvalDrift.ts — the submit is refused if anything differs. */
  refillOnSubmit?: boolean;
}

export interface ApplyOutcome {
  answers: AnswerEntry[];
  applications: ApplicationRecord[];
  summaryItem: RunSummaryItem;
  submitted: boolean;
  reachedReview: boolean;
  /** Set when the re-filled form no longer matches what was approved: nothing was submitted
   *  and the job needs a fresh approval. Carries the exact differences. */
  heldForReapproval?: { reasons: string[]; report: DriftReport; answers: FilledAnswer[] };
  queued: boolean;
  alreadyApplied: boolean;
  blockedRequired: string[];
}

async function detectDriver(page: Page): Promise<AtsDriver | undefined> {
  for (const driver of drivers) if (await driver.detect(page)) return driver;
  return undefined;
}

async function gotoWithRetry(page: Page, rawUrl: string, attempts = 3): Promise<void> {
  // Always open Workday in English. The trackers capture whatever locale the poster used, and
  // every RTX listing in the live list was /fr-CA/ — where the Apply button reads "Postuler", the
  // APPLY regex misses it, and the run ends at "0 field(s) / No next control" without ever
  // opening the form. Five of eleven failures in one batch were exactly this.
  const url = workdayEnglishUrl(rawUrl);
  if (url !== rawUrl) console.log(`  opening in English (was ${rawUrl.match(/\/([a-z]{2}-[A-Z]{2})\//)?.[1] ?? "?"})`);
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return;
    } catch (error) {
      lastError = error;
      console.log(`  goto attempt ${i + 1}/${attempts} failed: ${(error as Error).message.split("\n")[0]}`);
      await page.waitForTimeout(2000);
    }
  }
  throw lastError;
}

/**
 * Open, prefill, and (depending on mode) email-for-approval or submit ONE job.
 * Shared by the fill run (runner.ts) and the approval poller (approvals.ts).
 * Never clicks submit unless the job is explicitly approved.
 */
/**
 * Did we ask for a posting and land somewhere else? Then the posting is gone.
 *
 * Pure so it can be tested without a browser: npm run test:ats.
 *
 * Only a NUMERIC job id is used, which in practice means Greenhouse — Lever, Ashby and Workable
 * address a posting by uuid or slug, and Workday by a requisition path, so those are decided by the
 * query flag alone and keep their existing behaviour.
 */
export function redirectedAwayFromPosting(applyUrl: string, landedUrl: string): boolean {
  if (/[?&](error|not_found)=true/i.test(landedUrl)) return true;
  const askedFor = applyUrl.match(/\/jobs\/(\d{4,})/)?.[1];
  return Boolean(askedFor && !landedUrl.includes(askedFor));
}

export async function applyToJob(
  job: FilteredJob,
  identity: JobIdentity,
  answers: AnswerEntry[],
  applications: ApplicationRecord[],
  deps: ApplyDeps,
  opts: ApplyOptions,
): Promise<ApplyOutcome> {
  const { context, profile, agent, x8note, runDir } = deps;
  const notes = [...(opts.baseNotes ?? [])];
  const jobPage = await context.newPage();

  let recordedAts = identity.atsType;
  let jobDescriptionResolved = "";
  let resumeName: string | undefined;
  let resumeStandard: boolean | undefined;
  let submitted = false;
  let submitEvidence = "";
  let queued = false;
  // Set when this job looks like one we already engaged but shares no hard identifier.
  // Carried into the review email so the human — not this code — makes the call.
  let duplicateWarning: DuplicateWarning | undefined;

  const record = async (
    status: ApplicationRecord["status"],
    extra: {
      filledFields?: string[];
      unknownQuestions?: string[];
      notes?: string[];
      resume?: Awaited<ReturnType<typeof resolveResumeForJob>>;
      answers?: FilledAnswer[];
    } = {},
  ) => {
    applications = await recordApplication(applications, {
      id: identity.identityKey,
      code: job.id,
      company: job.company,
      title: job.title,
      location: job.location,
      region: job.region,
      applyUrl: job.applyUrl,
      ats: recordedAts,
      externalJobId: identity.externalJobId || undefined,
      companyReqId: identity.companyReqId,
      status,
      lastRunDir: runDir,
      jobDescription: jobDescriptionResolved,
      filledFields: extra.filledFields ?? [],
      unknownQuestions: extra.unknownQuestions ?? [],
      resumeName: extra.resume?.name ?? resumeName,
      resumeStandard: extra.resume?.isStandard ?? resumeStandard,
      resumeContent: extra.resume && !extra.resume.isStandard ? extra.resume.contentText : undefined,
      notes: [...notes, ...(extra.notes ?? [])],
      // The note carries the same material the review email shows.
      answers: extra.answers?.map((a) => ({ label: a.label, value: a.value, draft: a.draft })),
      duplicateWarning,
    });
    if (x8note && (status === "prefilled_pending_submit" || status === "already_applied_on_site" || status === "submitted")) {
      const saved = applications.find((entry) => entry.id === identity.identityKey);
      if (saved) {
        // x8note is the only store for the description and answers, so a failed write
        // loses them until the posting is visited again — retry once before giving up.
        let result = await postApplicationNote(x8note, saved);
        if (!result.noteId) result = await postApplicationNote(x8note, saved);
        if (result.noteId) saved.x8noteId = result.noteId;
        console.log(`  x8note: ${result.status}${result.noteId ? "" : " — content NOT stored, re-run this job to retry"}`);
      }
    }
  };

  const finish = (outcome: RunSummaryItem["outcome"], extraNotes: string[], flags: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
    answers,
    applications,
    summaryItem: { company: job.company, title: job.title, applyUrl: job.applyUrl, outcome, notes: [...notes, ...extraNotes] },
    submitted,
    reachedReview: false,
    queued,
    alreadyApplied: false,
    blockedRequired: [],
    ...flags,
  });

  try {
    await gotoWithRetry(jobPage, job.applyUrl);
    await jobPage.waitForTimeout(2500);

    /**
     * A withdrawn posting REDIRECTS, and the page it lands on says nothing about being closed.
     *
     * Greenhouse sends a dead job to the company's board index — job-boards.greenhouse.io/{co}/jobs/
     * {id} becomes job-boards.greenhouse.io/{co}?error=true, titled "Jobs at … Careers page" — so
     * the text test below finds no "no longer available" wording, the reader sees a list of other
     * people's roles, and the run ends "0 field(s), submitReady=false / No next control". That is
     * the signature of NOT BEING ON THE FORM, and it was being reported as a failure to fill.
     * Measured on cssmerge/jobs/8687896002.
     *
     * The rule is the one Workable already has (`not_found=true`): compare where we ASKED to go
     * with where we ended up. A posting whose own id is gone from the URL is gone.
     */
    const landed = jobPage.url();
    if (redirectedAwayFromPosting(job.applyUrl, landed)) {
      console.log(`  posting expired/closed — redirected to ${landed.slice(0, 90)}`);
      await record("expired", { notes: [`posting expired/closed (redirected to ${landed.slice(0, 120)})`] });
      await jobPage.close().catch(() => undefined);
      return finish("expired", ["posting expired/closed"]);
    }

    const pageText = (await jobPage.locator("body").innerText().catch(() => "")).toLowerCase();
    if (/doesn'?t exist|no longer (available|accepting|active)|posting (has )?closed|this job is not|job not found|job you requested was not found|position (is )?(no longer|has been) (open|filled|closed)|no jobs that fit|there are no jobs|0 jobs|page not found|n'existe pas|n'est plus|introuvable|no existe|ya no está/.test(pageText)) {
      console.log("  posting expired/closed — skipping.");
      // Record it, or the sweep re-opens the same dead listing forever: nothing was
      // written here before, so "expired" never reached the ledger and the skip in
      // ENGAGED_STATUSES had nothing to match. No x8note note is created for this status.
      await record("expired", { notes: ["posting expired/closed"] });
      await jobPage.close().catch(() => undefined);
      return finish("expired", ["posting expired/closed"]);
    }

    jobDescriptionResolved = await captureJobDescription(jobPage);
    if (!jobDescriptionResolved && x8note && job.id) {
      // Visited before? x8note is the single store, so read the description back from
      // this job's note rather than proceeding with nothing — the LLM's drafted answers
      // and the review email both depend on it, and re-scraping a page that already
      // failed rarely helps. by-label is immediately consistent, unlike search.
      const previously = await fetchStoredJobDescription(x8note, job.id);
      if (previously) {
        jobDescriptionResolved = previously;
        console.log(`  job description: reused ${previously.length} chars stored in x8note`);
      }
    }

    // Identity upgrade: find the EMPLOYER's own requisition id, which most postings print
    // only in the page body. An ATS id identifies a listing; this identifies the job, so
    // it is the one signal that recognises the same opening posted to a second board.
    /**
     * LEARN THE TITLE FROM THE PAGE when the job came in as a bare URL.
     *
     * A job added by hand starts as "(supplied by URL)" — internshipList has nothing else to put
     * there. That placeholder then follows it into the ledger and onto the review page, so the
     * candidate opened /queue/SHNNHM and had to ask what the job even was. The answer was in the
     * description we had just captured: "SOFTWARE ENGINEER INTERNSHIP, AGENT SYSTEMS", Employment
     * Type "Intern".
     *
     * Requisition ids are already discovered this way (withRequisitionId, right below) for the
     * same reason: most of what identifies a posting is only readable once the page is open.
     *
     * Taken from the first line that looks like a title and not like chrome — "ALL JOBS",
     * "Location", "Apply" and friends are skipped — and only ever used to REPLACE the
     * placeholder, never to overwrite a real title from a tracker.
     */
    if (/^\(supplied by url\)$/i.test((job.title ?? "").trim()) && jobDescriptionResolved) {
      const CHROME = /^(all jobs|jobs|apply|apply now|back|home|location|employment type|location type|department|share|save)$/i;
      const learned = jobDescriptionResolved
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length >= 8 && l.length <= 120 && !CHROME.test(l) && /[a-z]/i.test(l));
      if (learned) {
        console.log(`  learned the title from the page: ${JSON.stringify(learned.slice(0, 80))}`);
        job = { ...job, title: learned };
      }
    }

    const discoveredReqId = findRequisitionId(job.applyUrl, `${pageText}\n${jobDescriptionResolved}`);
    if (discoveredReqId && discoveredReqId !== identity.companyReqId) {
      identity = withRequisitionId(identity, discoveredReqId);
    }
    if (identity.companyReqId) console.log(`  requisition id: ${identity.companyReqId}`);

    // Hard guard: this exact job was already submitted through a DIFFERENT listing.
    const crossAts = findCrossAtsDuplicate(applications, identity);
    if (crossAts) {
      console.log(
        `  ⛔ same requisition (${identity.companyReqId}) was already submitted via ${crossAts.applyUrl} — not applying twice.`,
      );
      await record("already_applied_on_site", {
        notes: [`duplicate of ${crossAts.code ?? crossAts.id} (same requisition id ${identity.companyReqId}) — already submitted`],
      });
      await jobPage.close().catch(() => undefined);
      return finish("skipped_already_applied_on_site", [
        `duplicate requisition ${identity.companyReqId} — already submitted via ${crossAts.applyUrl}`,
      ], { alreadyApplied: true });
    }

    // Soft signal: same company + title with no shared identifier. Never decided here —
    // it is scored and surfaced in the review email so a human resolves it.
    // Ask x8note which stored postings are semantically close. This is the corroborating
    // signal for Lever and Ashby, which publish no requisition id — without it those ATS
    // have nothing but company+title to go on. Failures return [] and simply weaken the
    // signal; a duplicate check that cannot run must never block an application.
    let semanticHits: Awaited<ReturnType<typeof findSimilarPostings>> = [];
    if (x8note && !identity.companyReqId) {
      semanticHits = await findSimilarPostings(x8note, `${job.title} ${job.company} ${jobDescriptionResolved.slice(0, 400)}`, {
        excludeLabel: job.id ? `jobid_${job.id}` : undefined,
      });
      if (semanticHits.length) {
        console.log(`  x8note: ${semanticHits.length} semantically similar posting(s), top ${semanticHits[0].score.toFixed(2)} "${semanticHits[0].title}"`);
      }
    }
    // Map a hit back to the ledger record it belongs to, via its jobid_<CODE> label.
    const scoreForRecord = (r: ApplicationRecord): number | undefined =>
      semanticHits.find((hit) => r.code && hit.keywords.some((k) => k.toLowerCase() === `jobid_${r.code}`.toLowerCase()))?.score;

    const verdict = classifyJobMatch(applications, identity, scoreForRecord);
    if (verdict.decision === "possibly_same_job" && verdict.matched) {
      duplicateWarning = {
        confidence: verdict.confidence,
        basis: verdict.basis,
        otherCode: verdict.matched.code,
        otherUrl: verdict.matched.applyUrl,
        otherStatus: verdict.matched.status,
      };
      console.log(
        `  ⚠ possible duplicate (confidence ${(verdict.confidence * 100).toFixed(0)}%) of ${verdict.matched.code ?? verdict.matched.id}: ${verdict.basis} — flagged for your review, not skipped.`,
      );
    }

    const resume = await resolveResumeForJob(job);
    resumeName = resume.name;
    resumeStandard = resume.isStandard;
    console.log(`  resume: ${resume.name}${resume.isStandard ? " (standard)" : " (tailored)"}`);

    const driver = await detectDriver(jobPage);
    if (!driver) {
      await record("unsupported_ats", { notes: [`unsupported ats for ${jobPage.url()}`], resume });
      await jobPage.close().catch(() => undefined);
      return finish("unsupported_ats", [`unsupported ats for ${jobPage.url()}`]);
    }
    recordedAts = driver.type;

    // Clean approvals replay the exact approved answers (no LLM); everything else
    // (Phase A, change re-fills) uses the LLM agent, optionally with a correction.
    // A clean approval either REPLAYS the approved answers exactly, or (refillOnSubmit)
    // re-fills the live form preferring them and verifies the result before submitting.
    let hybrid: HybridAgent | undefined;
    let activeAgent: Agent = agent;
    if (opts.mode === "submit" && opts.replayAnswers) {
      if (opts.refillOnSubmit) {
        hybrid = new HybridAgent(opts.replayAnswers, agent);
        activeAgent = hybrid;
      } else {
        activeAgent = opts.replayAgent ?? new ReplayAgent(opts.replayAnswers);
      }
    }
    /**
     * A RUN NEEDS A WALL-CLOCK DEADLINE, not just a turn cap.
     *
     * maxTurns bounds the LOOP; it does not bound a single await. An Akuna Capital run stopped
     * logging after "✓ resume attached" and sat there for twenty-five minutes holding
     * data/.browser.lock — so every queued retry behind it waited too, and the only way out was
     * killing the worker by hand. Nothing in the pipeline noticed: the worker reported "busy" the
     * whole time, truthfully.
     *
     * The cap is deliberately generous (RUN_DEADLINE_MS, default 20 min). A Workday application
     * with seven experience rows legitimately takes ten or more, and a deadline that fires on a
     * healthy run would be worse than the hang. On expiry the run throws, which the caller already
     * records as an error and which releases the lock for whatever is queued behind it.
     */
    /**
     * 45 MINUTES. Twenty was too tight, and it killed this run at the finish line.
     *
     * Michelin reached "step 7 of 7 — Review" with submitReady=true — the application was DONE —
     * and the deadline fired before it could be recorded and queued. Seven steps, seven work
     * experience rows and 250-option dropdowns is legitimately more than twenty minutes of
     * clicking, and this is the second guard of mine to kill the same run in one evening.
     *
     * The deadline can afford to be generous now because it is no longer the thing that catches a
     * hang: READ_TIMEOUT_MS bounds the read, which is where both hangs seen so far actually sat
     * (Akuna, twice). This is the outer backstop for a hang somewhere else entirely — a click that
     * never returns, a dialog nothing dismisses — and for that, "much longer than any real
     * application" is exactly the right size.
     */
    const runDeadlineMs = Number(process.env.RUN_DEADLINE_MS ?? 45 * 60 * 1000);
    let runTimer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      runApplication(
      jobPage,
      driver,
      activeAgent,
      { company: job.company, title: job.title, resumeText: profile.resumeText || "", profile, answers, jobDescription: jobDescriptionResolved, changeInstruction: opts.changeInstruction },
      {
        resumePath: resume.path,
        // Checked against what the form already holds, not just against what the model says.
        facts: resumeFacts(profile),
        // How many jobs to enter, so the driver can add the rows Workday will not render on its own.
        experienceCount: parseResumeHistory(profile.resumeText || profile.rawText || "").experience?.length ?? 0,
        interactive: opts.interactive,
        maxTurns: driver.type === "workday" ? 18 : 8,
        // Where the per-page verification screenshots go. Without it that check is skipped.
        runDir,
        onLearn: async (field) => {
          const value = await askUserForField(field, { company: job.company, title: job.title, url: jobPage.url() });
          if (value) {
            const question: FormQuestion = {
              label: field.label,
              normalizedLabel: normalizeQuestion(field.label),
              type: field.type,
              required: field.required,
              options: field.options ?? [],
              locatorDescription: field.label,
            };
            answers = await addLearnedAnswer(answers, question, value);
          }
          return value;
        },
      },
      ),
      new Promise<never>((_, reject) => {
        runTimer = setTimeout(
          () => reject(new Error(`the run passed its ${Math.round(runDeadlineMs / 60000)}-minute deadline with no result — abandoning it so the browser is free for the next job`)),
          runDeadlineMs,
        );
      }),
    ]).finally(() => {
      if (runTimer) clearTimeout(runTimer);
    }) as Awaited<ReturnType<typeof runApplication>>;

    if (!jobDescriptionResolved && driver.type === "greenhouse") {
      jobDescriptionResolved = await fetchGreenhouseJobDescription(jobPage, job.applyUrl);
    }

    // Preserve what THIS visit saw, before anything else can change: the pre-approval copy
    // and the copy present at submit time are what settle "did the form change?".
    if (job.id && result.observedFields.length) {
      await saveRound({
        code: job.id,
        phase: opts.mode === "submit" ? "submit" : opts.changeInstruction ? "refill" : "fill",
        url: job.applyUrl,
        fields: result.observedFields.map((f) => ({ label: f.label, type: f.type, required: f.required, options: f.options })),
        answers: result.answers.map((a) => ({ label: a.label, value: a.value, draft: a.draft })),
        outcome: result.reachedReview ? "reached review" : `blocked: ${result.blockedRequired.join("; ") || "did not reach review"}`,
      }).catch(() => undefined);
    }

    /**
     * THE FORM WAS SUBMITTED AND WE DID NOT MEAN TO.
     *
     * Recorded before anything else, because the employer already has the application and every
     * guard downstream keys off the ledger: leaving it `prefilled_pending_submit` is what let six
     * of these sit in the approval queue afterwards, each one an Approve click away from being sent
     * a SECOND time.
     *
     * Recorded as `submitted`, not as a failure, because that is what happened. The run is reported
     * as a failure separately — an application going in without approval is the most serious thing
     * this system can do, and it must be impossible to miss in the log.
     */
    if (result.submittedUnexpectedly) {
      console.log(`  ⛔ [${job.id ?? ""}] ${job.company} — SUBMITTED WITHOUT APPROVAL. Recording it so it can never be sent again.`);
      await record("submitted", {
        filledFields: result.filled,
        answers: result.answers,
        resume,
        notes: ["SUBMITTED WITHOUT APPROVAL — the page showed a confirmation at the end of a fill run"],
      });
      await jobPage.close().catch(() => undefined);
      return finish("submitted", ["SUBMITTED WITHOUT APPROVAL — the page showed a confirmation at the end of a fill run"], {
        submitted: true,
      });
    }

    if (result.alreadyApplied) {
      await record("already_applied_on_site", { filledFields: result.filled, resume, notes: ["already applied on site"] });
      await jobPage.close().catch(() => undefined);
      return finish("skipped_already_applied_on_site", ["already applied on site"], { alreadyApplied: true });
    }

    if (!result.reachedReview) {
      const dbg = path.join(runDir, `debug-${job.id ?? "job"}.png`);
      await scrollToTop(jobPage);
      await captureFormShot(jobPage, dbg);
      console.log(`  ⚠ stopped before review (${result.filled.length} filled) — debug: ${dbg}`);
      if (result.blockedRequired.length) {
        console.log(`  ⛔ blocked by ${result.blockedRequired.length} empty required field(s): ${result.blockedRequired.join(" | ")}`);
      }
      /**
       * A RUN THAT DID NOT REACH REVIEW IS AN ERROR, NOT A FILLED APPLICATION.
       *
       * This recorded `prefilled_pending_submit`, whose own definition in statusVocabulary reads
       * "The form was filled and left at the review step. Nothing was sent." — for runs that
       * stopped BEFORE the review step. 224 records in the ledger say that today, and only one in
       * eight sampled has a review screenshot to show for it.
       *
       * The label is the smaller half. `prefilled_pending_submit` is in ENGAGED_STATUSES, so every
       * one of those jobs is skipped by every future sweep: 224 postings retired without ever
       * being finished, accumulating since 28 August, which is why new applications stopped
       * appearing while the run log stayed busy. `error` is deliberately NOT engaged — the comment
       * further down this file says so — so the job stays visible and a later sweep can try again.
       *
       * The screenshot and the reasons are on /blocked in the website, which is where a blocked
       * job gets looked at now.
       */
      // Same reasoning as the incomplete-at-review path: do not leave an older, equally unfinished
      // copy sitting in the queue with an Approve button next to it.
      await retireStaleQueuedCopy(
        job.id || identity.identityKey,
        result.blockedRequired.length
          ? `blocked on: ${result.blockedRequired.slice(0, 6).join("; ")}`
          : "the run stopped before the form was finished",
        job.id,
      );
      await record("error", {
        filledFields: result.filled,
        unknownQuestions: result.unknown,
        answers: result.answers,
        resume,
        notes: [
          `turns: ${result.turns}`,
          ...(result.blockedRequired.length ? [`blocked by empty required: ${result.blockedRequired.join("; ")}`] : []),
          "stopped before review",
        ],
      });
      await jobPage.close().catch(() => undefined);
      return finish("opened_and_prefilled", [
        ...result.filled.map((i) => `filled ${i}`),
        ...(result.blockedRequired.length ? [`blocked required: ${result.blockedRequired.join("; ")}`] : []),
      ], { blockedRequired: result.blockedRequired });
    }

    // Reached Review. The screenshot is what the website's review page links to. The rest of
    // the old "review payload" existed only to be rendered into an email — every field of it
    // is already on the queue entry written below.
    const shotPath = path.join(runDir, `review-${job.id ?? "job"}.png`);
    await scrollToTop(jobPage);
    const shotKind = await captureFormShot(jobPage, shotPath);
    console.log(
      `  Review screenshot: ${shotPath}${shotKind === "tall" ? "" : " (fullPage fallback — an embedded form may be missing from it)"}`,
    );

    /**
     * Cross-check the SCREEN against what we believe we filled — ASYNCHRONOUSLY.
     *
     * Every bad application this session had the same shape: the DOM said a value was there and
     * the screen disagreed. The clearest was a Workable End date recorded as "05/2028" that the
     * screenshot showed as an empty "MM/YYYY" — read() asked the input and the input lied. OCR of
     * the screenshot is the only source that cannot lie in that direction.
     *
     * This used to await the OCR here, which cost 6-56s at the end of every fill — on a run that
     * is already the slowest thing this project does. It no longer waits. The screenshot goes to
     * x8ocr as a job, x8ocr POSTs the result back to the website, and the worker applies the
     * verdict to the queue entry (see the "visual_check" command).
     *
     * The verdict is a GATE, not a note: submitApprovedEntry() refuses to submit while it is
     * "pending" or "gaps". That is what makes returning early safe — an approval arriving before
     * the result does cannot send an unverified application.
     *
     * Best-effort as before: no OCR service, a refused submission, or a result that never comes
     * back all end as "unavailable", which says NOTHING rather than blaming the application.
     * Set OCR_VERIFY=0 to skip it.
     */
    let visualCheck: NonNullable<PendingEntry["visualCheck"]> | undefined;
    if (process.env.OCR_VERIFY !== "0") {
      const jobId = await submitOcrJob(shotPath, { code: job.id ?? "job" });
      if (jobId) {
        visualCheck = { state: "pending", jobId, at: new Date().toISOString() };
        console.log(`  👁 visual cross-check queued (x8ocr job ${jobId}) — verdict applies before any submit`);
      } else {
        visualCheck = { state: "unavailable", at: new Date().toISOString() };
        console.log(`  (visual cross-check unavailable — not submitted to x8ocr)`);
      }
    }

    /**
     * The whole-application guardrail, in the ONE place every submit passes through — the
     * emailed/website approval path, the terminal confirmation, and any future caller. Putting it
     * in each caller is how the submit guards drifted apart once before.
     *
     * An approval is permission to send THIS application, not permission to send anything. If the
     * form asked for education or work history and every one of those fields is blank, no approval
     * makes that sensible, so this refuses regardless. See applicationSanity.ts.
     */
    const doSubmit = async () => {
      const problems = reviewApplication({
        answers: result.answers,
        observedFields: result.observedFields,
        resumeAttached: result.resumeAttached,
        history: result.history,
        documents: result.documents,
        facts: resumeFacts(profile),
      });
      if (problems.length) {
        console.log(`  ⛔ NOT submitting — this application does not make sense to send:`);
        for (const p of problems) console.log(`     • ${p.message}`);
        console.log(`     Re-fill it (./bin/jobapp retry ${job.id}) rather than approving it again.`);
        return;
      }
      const root = await driver.resolveRoot(jobPage);
      submitted = await driver.submit(root).catch(() => false);
      /**
       * SAY WHAT THE PAGE DID, not just that we clicked. "✅ Submitted." rested on a click having
       * been dispatched; two applications carried that word with no acknowledgement email from
       * either employer, and there was no way to tell from the record whether the click had landed.
       */
      submitEvidence = (driver as { lastSubmitEvidence?: string }).lastSubmitEvidence ?? "";
      /**
       * THREE OUTCOMES, NOT TWO. "Submit control not found" was the only failure this could
       * report, so a click that landed on a real button and changed nothing came out sounding
       * like a missing button — or, worse, was recorded as a submit. PIBFFI was: the candidate
       * submitted it by hand afterwards, got the acknowledgement, and told us the real page says
       * "Success — Your application was successfully submitted."
       */
      console.log(
        submitted
          ? `  ✅ Submitted — ${submitEvidence || "no evidence either way"}.`
          : submitEvidence
            ? `  ⛔ NOT submitted — ${submitEvidence}. Nothing was sent; this needs looking at on the ATS.`
            : "  ⚠️ Submit control not found — nothing was sent.",
      );
      await jobPage.waitForTimeout(2000);
    };

    if (opts.mode === "submit") {
      // Phase B: the caller already verified an APPROVE reply for this job. When the form was
      // re-filled rather than replayed, the approval covers the VALUES the user read — so the
      // form as it now stands is checked against them, and a single difference stops the click.
      const report =
        hybrid && opts.replayAnswers ? compareToApproved(opts.replayAnswers, result.answers) : undefined;
      if (report && !report.safeToSubmit) {
        const reasons = describeDrift(report);
        console.log(`  ⛔ NOT submitting — ${reasons.length} difference(s) from what you approved:`);
        for (const line of reasons.slice(0, 5)) console.log(`     • ${line}`);
        await record("prefilled_pending_submit", { filledFields: result.filled, resume, notes: ["held for re-approval", ...reasons] });
        await jobPage.close().catch(() => undefined);
        return finish("prefilled_reached_review", ["held for re-approval", ...reasons], {
          reachedReview: true,
          heldForReapproval: { reasons, report, answers: result.answers },
        });
      }
      if (report) {
        console.log(
          `  ✓ re-filled and verified: ${report.matched} value(s) match what you approved` +
            (report.rewordedButSame.length ? `, ${report.rewordedButSame.length} reworded question(s) carry the same answer` : "") +
            (report.vanished.length ? `, ${report.vanished.length} approved question(s) no longer on the form` : ""),
        );
      }
      await doSubmit();
    } else {
      // A filled application goes straight into the queue for review on the website. There is
      // no longer a review email and no grace wait: approval arrives as a command from the
      // website (or ./bin/jobapp), which the worker executes. The fill run never blocks.
      //
      // The grace wait existed so an immediate emailed APPROVE could submit inside the same
      // session. It also meant a fill run could submit without anyone having opened the
      // website — the queue entry and the review were the same event. Now they are not.
      // Reaching the Submit control is not the same as being READY to submit. Check the
      // application as a whole before asking a human to bless it: an application whose education
      // and work history are blank is not something to put in a review queue and wait on, it is
      // something to re-fill. Caught on four Workable jobs that all reached review empty.
      const gaps = [
        ...reviewApplication({
          answers: result.answers,
          observedFields: result.observedFields,
          resumeAttached: result.resumeAttached,
          history: result.history,
          documents: result.documents,
          facts: resumeFacts(profile),
        }),
        // The visual cross-check is NOT part of this gate any more: it has not returned yet.
        // It gates the SUBMIT instead (submitApprovedEntry), which is the point every send
        // passes through — so a gap still stops the application, just later and without making
        // every fill wait for OCR first.
      ];
      if (gaps.length) {
        console.log(`  ⛔ reached review, but the application is not worth sending:`);
        for (const g of gaps) console.log(`     • ${g.message}`);
        await record("prefilled_pending_submit", {
          filledFields: result.filled,
          unknownQuestions: result.unknown,
          answers: result.answers,
          resume,
          notes: [`turns: ${result.turns}`, `incomplete: ${describeProblems(gaps)}`],
        });
        await jobPage.close().catch(() => undefined);

        // A PREVIOUS fill of this job may already be sitting in the queue as awaiting_approval —
        // that is exactly the case on a re-fill, which is when this fires. Blocking the new attempt
        // while leaving the old entry approvable is the worst of both: the run says the application
        // is not worth sending, and the website still offers an Approve button for the older,
        // equally incomplete copy of it. Seen on NMVTAA (1 of 7 roles). Mark it `error` — it is
        // excluded from listAwaiting(), so approve and retry both refuse it until a good re-fill
        // replaces it.
        await retireStaleQueuedCopy(job.id || identity.identityKey, `incomplete: ${describeProblems(gaps)}`, job.id);

        // NOT queued for approval — it goes to /blocked with the reason, so nobody is asked to
        // approve an application with no education on it.
        return finish("prefilled_pending_submit", [`incomplete: ${describeProblems(gaps)}`], {
          blockedRequired: gaps.map((g) => g.message),
        });
      }

      if (opts.interactive && process.stdin.isTTY && process.env.NO_SUBMIT !== "1") {
        // A hand-run fill can still submit on an explicit typed confirmation.
        if (await confirmSubmit({ company: job.company, title: job.title })) await doSubmit();
      } else {
        console.log("  Reached review — queued for approval on the website.");
      }

      // Queue every un-submitted reached-review job, so it is waiting on the website.
      if (!submitted) {
        await upsertPending({
          key: job.id || identity.identityKey,
          code: job.id,
          identityKey: identity.identityKey,
          externalJobId: identity.externalJobId || undefined,
          companyReqId: identity.companyReqId,
          ats: recordedAts,
          company: job.company,
          title: job.title,
          applyUrl: job.applyUrl,
          location: job.location,
          region: job.region,
          resumeName: resume.name,
          resumeStandard: resume.isStandard,
          jobDescription: jobDescriptionResolved,
          filledFields: result.filled,
          answers: result.answers,
          reviewSentAt: new Date().toISOString(),
          // A fresh fill is a fresh start. upsertPending keeps the previous status and attempt
          // count, so a job parked as "error" after three failed submits would come back still
          // parked — a new copy nobody could act on — and one that had given up would give up
          // again on its first stumble. The stale failure and any stale hold go too; the DECISION
          // fields stay, so the queue can still say "you approved the older copy".
          status: "awaiting_approval",
          attempts: 0,
          lastError: undefined,
          reapproval: undefined,
          // A fresh fill means a fresh screen: the previous verdict described a screenshot that
          // no longer exists, so it must be replaced, never inherited.
          visualCheck,
        });
        queued = true;
        console.log("  → queued for approval (poller will submit once you reply APPROVE).");
      } else {
        // Submitted during the fill run (terminal confirmation or grace-wait approval):
        // close out any existing queue entry. Leaving it "awaiting_approval" is exactly
        // how a job gets submitted TWICE — the cron poller would later find the same
        // APPROVE reply still unprocessed and replay the submit against a live form.
        // No-ops when the job was never queued.
        await updatePendingStatus(job.id || identity.identityKey, "submitted");
      }
    }

    const status: ApplicationRecord["status"] = submitted ? "submitted" : "prefilled_pending_submit";
    await record(status, {
      filledFields: result.filled,
      unknownQuestions: result.unknown,
      answers: result.answers,
      resume,
      notes: [
        `turns: ${result.turns}`,
        ...(result.drafts.length ? [`drafts to review: ${result.drafts.join("; ")}`] : []),
        submitted
          ? `submitted on approval — ${submitEvidence || "the page gave no signal either way"}`
          : queued
            ? "queued for approval"
            : "submit not clicked",
      ],
    });
    // (A "submitted" confirmation email used to go out here. The website's history page is
    // the record now.)

    const outcome: RunSummaryItem["outcome"] = submitted ? "submitted" : "prefilled_reached_review";
    console.log(`  → ${outcome}: ${result.filled.length} filled, ${result.drafts.length} draft(s), ${result.unknown.length} left`);
    await jobPage.close().catch(() => undefined);
    return finish(outcome, [
      ...result.filled.map((i) => `filled ${i}`),
      ...result.unknown.map((l) => `unknown ${l}`),
      submitted ? "submitted" : queued ? "queued for approval" : "submit not clicked",
    ], { reachedReview: true });
  } catch (error) {
    const message = (error as Error).message.split("\n")[0];
    console.log(`  error processing job: ${message}`);
    /**
     * RECORD THE ATTEMPT. A run that throws used to leave NOTHING in the ledger, so the job was
     * invisible on every page — not on /queue (it never reached review), not on /blocked (that
     * reads prefilled_pending_submit), not on /applications (no record at all). Three postings
     * added by hand vanished exactly this way, one of them because a worker restart killed the
     * run mid-fill, and the only trace was a line in worker.log.
     *
     * `error` is deliberately NOT in ENGAGED_STATUSES, so this makes the job VISIBLE without
     * making it unrepeatable — the next sweep may still open it. Best effort: the browser is
     * often already gone by here, and a failure to write must not replace the real error.
     */
    await record("error", { notes: [message] }).catch(() => undefined);
    await jobPage.close().catch(() => undefined);
    return finish("error", [message]);
  }
}
