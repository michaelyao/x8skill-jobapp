import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { AshbyDriver } from "../agent/drivers/ashby.js";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { LeverDriver } from "../agent/drivers/lever.js";
import { runApplication } from "../agent/turnLoop.js";
import { ReplayAgent } from "../agent/replayAgent.js";
import { HybridAgent } from "../agent/hybridAgent.js";
import { compareToApproved, describeDrift, type DriftReport } from "./approvalDrift.js";
import { addLearnedAnswer } from "../knowledge/answerStore.js";
import {
  classifyJobMatch,
  findCrossAtsDuplicate,
  recordApplication,
} from "../knowledge/applications.js";
import { upsertPending, updatePendingStatus } from "../knowledge/approvalQueue.js";
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

const drivers: AtsDriver[] = [new WorkdayDriver(), new AshbyDriver(), new GreenhouseDriver(), new LeverDriver()];

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
    const result = await runApplication(
      jobPage,
      driver,
      activeAgent,
      { company: job.company, title: job.title, resumeText: profile.resumeText || "", profile, answers, jobDescription: jobDescriptionResolved, changeInstruction: opts.changeInstruction },
      {
        resumePath: resume.path,
        interactive: opts.interactive,
        maxTurns: driver.type === "workday" ? 18 : 8,
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
    );

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

    if (result.alreadyApplied) {
      await record("already_applied_on_site", { filledFields: result.filled, resume, notes: ["already applied on site"] });
      await jobPage.close().catch(() => undefined);
      return finish("skipped_already_applied_on_site", ["already applied on site"], { alreadyApplied: true });
    }

    if (!result.reachedReview) {
      const dbg = path.join(runDir, `debug-${job.id ?? "job"}.png`);
      await jobPage.screenshot({ path: dbg, fullPage: true }).catch(() => undefined);
      console.log(`  ⚠ stopped before review (${result.filled.length} filled) — debug: ${dbg}`);
      if (result.blockedRequired.length) {
        console.log(`  ⛔ blocked by ${result.blockedRequired.length} empty required field(s): ${result.blockedRequired.join(" | ")}`);
      }
      // The screenshot and the reasons are on /blocked in the website, which is where a
      // blocked job gets looked at now. It used to be mailed out as well.
      await record("prefilled_pending_submit", {
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
    await jobPage.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
    console.log(`  Review screenshot: ${shotPath}`);

    const doSubmit = async () => {
      const root = await driver.resolveRoot(jobPage);
      submitted = await driver.submit(root).catch(() => false);
      console.log(submitted ? "  ✅ Submitted." : "  ⚠️ Submit control not found.");
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
        submitted ? "submitted on approval" : queued ? "queued for approval" : "submit not clicked",
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
    await jobPage.close().catch(() => undefined);
    return finish("error", [message]);
  }
}
