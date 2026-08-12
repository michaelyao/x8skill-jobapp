import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loadEnv } from "./utils/env.js";
import { AUTH_DIR, DATA_DIR } from "./config.js";
import { LlmAgent } from "./agent/llmAgent.js";
import { applyToJob, type ApplyDeps } from "./core/applyJob.js";
import { buildJobIdentity } from "./core/jobIdentity.js";
import { loadAnswers } from "./knowledge/answerStore.js";
import { loadApplications } from "./knowledge/applications.js";
import {
  listAwaiting,
  markReplyProcessed,
  updatePendingStatus,
  type PendingEntry,
} from "./knowledge/approvalQueue.js";
import { loadProfile } from "./knowledge/profile.js";
import { loadX8NoteConfig } from "./knowledge/x8note.js";
import { checkApprovalOnce, type ReplyDecision, type ReviewData } from "./knowledge/reviewEmail.js";
import { makeRunDir, ensureDir } from "./utils/log.js";
import type { FilteredJob } from "./types.js";

const reviewDataFor = (entry: PendingEntry): ReviewData => ({
  company: entry.company,
  title: entry.title,
  code: entry.code,
  applyUrl: entry.applyUrl,
  jobDescription: entry.jobDescription ?? "",
  filledFields: entry.filledFields ?? [],
});

/** Rebuild a FilteredJob from a queued entry (Phase B never re-reads the CSV,
 *  since a days-old posting may have aged out of the fresh list). */
function jobFromEntry(entry: PendingEntry): FilteredJob {
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

/**
 * Phase B: scan the inbox for APPROVE/SKIP replies to queued applications and act
 * on them. APPROVE → re-open the job, re-fill to Review, and submit. SKIP → mark
 * skipped. Everything else stays queued. Designed to be run repeatedly by cron.
 */
const LOCK_PATH = path.join(DATA_DIR, ".approvals.lock");
const LOCK_STALE_MS = 30 * 60 * 1000; // a run older than this is presumed dead

/** Prevent overlapping poller runs (cron may fire while a prior run is active). */
function acquireLock(): boolean {
  try {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false; // fresh lock held
  } catch {
    /* no lock file — free to take it */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}
function releaseLock(): void {
  try {
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    /* best effort */
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (!acquireLock()) {
    console.log("Approval poller: another run holds the lock — skipping this cycle.");
    return;
  }
  try {
    await runPoll();
  } finally {
    releaseLock();
  }
}

async function runPoll(): Promise<void> {
  const awaiting = await listAwaiting();
  if (awaiting.length === 0) {
    console.log("Approval poller: nothing awaiting approval.");
    return;
  }
  console.log(`Approval poller: ${awaiting.length} job(s) awaiting approval.`);

  // First pass (no browser): classify each entry by the user's reply.
  const classified: Array<{ entry: PendingEntry; reply: ReplyDecision }> = [];
  for (const entry of awaiting) {
    const reply = await checkApprovalOnce(reviewDataFor(entry), { ignoreIds: entry.processedReplyIds });
    console.log(`  [${entry.code ?? entry.key}] ${entry.company} — reply: ${reply.decision}`);
    classified.push({ entry, reply });
  }

  // SKIP needs no browser.
  for (const { entry, reply } of classified.filter((c) => c.reply.decision === "skip")) {
    if (reply.messageId) await markReplyProcessed(entry.key, reply.messageId);
    await updatePendingStatus(entry.key, "skipped");
    console.log(`  [${entry.code ?? entry.key}] marked skipped.`);
  }

  const toApprove = classified.filter((c) => c.reply.decision === "approved");
  const toChange = classified.filter((c) => c.reply.decision === "change");
  if (toApprove.length === 0 && toChange.length === 0) {
    console.log("Approval poller: no approvals or change requests to act on.");
    return;
  }

  // Spin up a browser only when there is real work (a submit or a change re-fill).
  const runDir = makeRunDir();
  await ensureDir(runDir);
  const profile = await loadProfile();
  let answers = await loadAnswers();
  let applications = await loadApplications();
  const x8note = await loadX8NoteConfig();
  let context;
  try {
    context = await chromium.launchPersistentContext(AUTH_DIR, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1440, height: 1000 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (error) {
    // The persistent Chrome profile is single-instance: a concurrent fill run
    // holds it. Skip this cycle — the next cron tick will pick these up.
    console.log(`Approval poller: Chrome profile busy — ${toApprove.length + toChange.length} item(s) deferred to next cycle. (${(error as Error).message.split("\n")[0]})`);
    return;
  }
  const deps: ApplyDeps = { context, profile, agent: new LlmAgent(), x8note, runDir };
  const MAX_ATTEMPTS = 3;

  try {
    // Clean approvals → replay the approved answers exactly and submit.
    for (const { entry, reply } of toApprove) {
      console.log(`Submitting approved [${entry.code ?? entry.key}] ${entry.company} - ${entry.title}`);
      const job = jobFromEntry(entry);
      const identity = buildJobIdentity(job);
      const outcome = await applyToJob(job, identity, answers, applications, deps, {
        mode: "submit",
        interactive: false,
        graceMs: 0,
        replayAnswers: entry.answers ?? [],
        baseNotes: ["approved via email"],
      });
      answers = outcome.answers;
      applications = outcome.applications;
      const attempts = (entry.attempts ?? 0) + 1;
      if (outcome.submitted) {
        if (reply.messageId) await markReplyProcessed(entry.key, reply.messageId);
        await updatePendingStatus(entry.key, "submitted", { attempts });
        console.log(`  ✅ [${entry.code ?? entry.key}] submitted.`);
      } else if (outcome.alreadyApplied) {
        if (reply.messageId) await markReplyProcessed(entry.key, reply.messageId);
        await updatePendingStatus(entry.key, "submitted", { attempts, lastError: "already applied on site" });
        console.log(`  ✅ [${entry.code ?? entry.key}] already applied on site — marking submitted.`);
      } else {
        const err = outcome.reachedReview
          ? "submit control not found"
          : `did not reach review on replay${outcome.blockedRequired?.length ? ` (blocked: ${outcome.blockedRequired.join("; ")})` : ""}`;
        // Keep it awaiting so the next cron retries, up to a cap; then give up.
        const status = attempts >= MAX_ATTEMPTS ? "error" : "awaiting_approval";
        await updatePendingStatus(entry.key, status, { attempts, lastError: err });
        console.log(`  ⚠️ [${entry.code ?? entry.key}] not submitted (attempt ${attempts}/${MAX_ATTEMPTS}): ${err} — ${status === "error" ? "giving up" : "will retry"}.`);
      }
    }

    // Change requests → re-fill applying the user's correction, then email a fresh
    // review for re-approval. The original change reply is marked processed so it
    // won't re-trigger; only a NEW reply to the updated review acts next.
    for (const { entry, reply } of toChange) {
      console.log(`Applying change to [${entry.code ?? entry.key}] ${entry.company}: "${(reply.changeText ?? "").slice(0, 120)}"`);
      if (reply.messageId) await markReplyProcessed(entry.key, reply.messageId);
      const job = jobFromEntry(entry);
      const identity = buildJobIdentity(job);
      const outcome = await applyToJob(job, identity, answers, applications, deps, {
        mode: "fill", // re-fill with the LLM, then email a new review (graceMs 0 → straight to queue)
        interactive: false,
        graceMs: 0,
        changeInstruction: reply.changeText,
        baseNotes: ["change requested via email"],
      });
      answers = outcome.answers;
      applications = outcome.applications;
      if (outcome.queued) {
        console.log(`  ✏️  [${entry.code ?? entry.key}] updated & re-review email sent — awaiting your APPROVE.`);
      } else {
        console.log(`  ⚠️ [${entry.code ?? entry.key}] change re-fill did not reach review${outcome.blockedRequired?.length ? ` (blocked: ${outcome.blockedRequired.join("; ")})` : ""} — stays queued, reply again to retry.`);
      }
    }
  } finally {
    await context.close();
  }
  console.log(`Approval poller done. Logs in ${runDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
