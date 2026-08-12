import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { AshbyDriver } from "../agent/drivers/ashby.js";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { LeverDriver } from "../agent/drivers/lever.js";
import { runApplication } from "../agent/turnLoop.js";
import { ReplayAgent } from "../agent/replayAgent.js";
import { addLearnedAnswer } from "../knowledge/answerStore.js";
import { recordApplication } from "../knowledge/applications.js";
import { upsertPending } from "../knowledge/approvalQueue.js";
import { resolveResumeForJob } from "../knowledge/resume.js";
import { postApplicationNote, type X8NoteConfig } from "../knowledge/x8note.js";
import {
  checkApprovalOnce,
  reviewTo,
  sendReviewEmail,
  sendSubmittedEmail,
  waitForApproval,
} from "../knowledge/reviewEmail.js";
import { captureJobDescription, fetchGreenhouseJobDescription } from "../utils/jobDescription.js";
import { askUserForField, confirmSubmit } from "../utils/prompts.js";
import { normalizeQuestion } from "../utils/normalize.js";
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
  graceMs: number; // Phase A inline grace wait before queuing
  baseNotes?: string[];
  changeInstruction?: string; // "fill" mode: user's emailed correction to apply
  replayAnswers?: FilledAnswer[]; // "submit" mode: exact approved answers to replay
}

export interface ApplyOutcome {
  answers: AnswerEntry[];
  applications: ApplicationRecord[];
  summaryItem: RunSummaryItem;
  submitted: boolean;
  reachedReview: boolean;
  queued: boolean;
  alreadyApplied: boolean;
  blockedRequired: string[];
}

async function detectDriver(page: Page): Promise<AtsDriver | undefined> {
  for (const driver of drivers) if (await driver.detect(page)) return driver;
  return undefined;
}

async function gotoWithRetry(page: Page, url: string, attempts = 3): Promise<void> {
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

  const record = async (
    status: ApplicationRecord["status"],
    extra: { filledFields?: string[]; unknownQuestions?: string[]; notes?: string[]; resume?: Awaited<ReturnType<typeof resolveResumeForJob>> } = {},
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
      status,
      lastRunDir: runDir,
      jobDescription: jobDescriptionResolved,
      filledFields: extra.filledFields ?? [],
      unknownQuestions: extra.unknownQuestions ?? [],
      resumeName: extra.resume?.name ?? resumeName,
      resumeStandard: extra.resume?.isStandard ?? resumeStandard,
      resumeContent: extra.resume && !extra.resume.isStandard ? extra.resume.contentText : undefined,
      notes: [...notes, ...(extra.notes ?? [])],
    });
    if (x8note && (status === "prefilled_pending_submit" || status === "already_applied_on_site" || status === "submitted")) {
      const saved = applications.find((entry) => entry.id === identity.identityKey);
      if (saved) console.log(`  x8note: ${await postApplicationNote(x8note, saved)}`);
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
      await jobPage.close().catch(() => undefined);
      return finish("expired", ["posting expired/closed"]);
    }

    jobDescriptionResolved = await captureJobDescription(jobPage);

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
    const activeAgent: Agent = opts.mode === "submit" && opts.replayAnswers ? new ReplayAgent(opts.replayAnswers) : agent;
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
      await record("prefilled_pending_submit", {
        filledFields: result.filled,
        unknownQuestions: result.unknown,
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

    // Reached Review. Build the shared review payload.
    const shotPath = path.join(runDir, `review-${job.id ?? "job"}.png`);
    await jobPage.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
    const reviewData = {
      company: job.company,
      title: job.title,
      code: job.id,
      applyUrl: job.applyUrl,
      location: job.location,
      region: job.region,
      resumeName: resume.name,
      resumeStandard: resume.isStandard,
      jobDescription: jobDescriptionResolved,
      filledFields: result.filled,
      answers: result.answers.map((a) => ({ label: a.label, value: a.value, draft: a.draft })),
    };

    const doSubmit = async () => {
      const root = await driver.resolveRoot(jobPage);
      submitted = await driver.submit(root).catch(() => false);
      console.log(submitted ? "  ✅ Submitted." : "  ⚠️ Submit control not found.");
      await jobPage.waitForTimeout(2000);
    };

    if (opts.mode === "submit") {
      // Phase B: the caller already verified an APPROVE reply for this job.
      await doSubmit();
    } else {
      // Phase A: email the review, wait briefly for an immediate reply, else queue.
      const emailResult = await sendReviewEmail(reviewData, shotPath);
      console.log(`  Review email → ${reviewTo()}: ${emailResult}`);

      // NO_SUBMIT=1 = hard no-submit: email the review + queue, but NEVER submit
      // during the fill run (not even on a detected approval). graceMs<=0 also skips
      // the wait. Otherwise wait briefly for an immediate approval by CODE.
      if (process.env.NO_SUBMIT === "1" || opts.graceMs <= 0) {
        console.log("  NO_SUBMIT — review emailed; will NOT submit during fill (queued for the poller).");
      } else {
        console.log(`  Grace wait up to ${Math.round(opts.graceMs / 1000)}s for an immediate reply (approval can also come later)...`);
        const emailApproval = waitForApproval(reviewData, { timeoutMs: opts.graceMs, pollMs: 20000 });
        const approval = opts.interactive && process.stdin.isTTY
          ? await Promise.race([emailApproval, confirmSubmit({ company: job.company, title: job.title }).then((ok) => (ok ? "approved" : "skip") as "approved" | "skip")])
          : await emailApproval;
        console.log(`  Grace result: ${approval}`);
        if (approval === "approved") await doSubmit();
      }

      // Always queue an un-submitted reached-review job so the poller can submit it
      // later on an emailed APPROVE — regardless of NO_SUBMIT.
      if (!submitted) {
        await upsertPending({
          key: job.id || identity.identityKey,
          code: job.id,
          identityKey: identity.identityKey,
          externalJobId: identity.externalJobId || undefined,
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
        });
        queued = true;
        console.log("  → queued for approval (poller will submit once you reply APPROVE).");
      }
    }

    const status: ApplicationRecord["status"] = submitted ? "submitted" : "prefilled_pending_submit";
    await record(status, {
      filledFields: result.filled,
      unknownQuestions: result.unknown,
      resume,
      notes: [
        `turns: ${result.turns}`,
        ...(result.drafts.length ? [`drafts to review: ${result.drafts.join("; ")}`] : []),
        submitted ? "submitted on approval" : queued ? "queued for approval" : "submit not clicked",
      ],
    });
    if (submitted && opts.mode === "submit") await sendSubmittedEmail(reviewData).catch(() => undefined);

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
