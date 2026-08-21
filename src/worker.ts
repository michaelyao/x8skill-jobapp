import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { loadEnv } from "./utils/env.js";
import { AUTH_DIR, DATA_DIR } from "./config.js";
import { LlmAgent } from "./agent/llmAgent.js";
import { buildJobIdentity } from "./core/jobIdentity.js";
import { applyToJob, type ApplyDeps } from "./core/applyJob.js";
import { jobFromEntry, submitApprovedEntry } from "./core/submitApproved.js";
import { addLearnedAnswer, forgetLearnedAnswers, loadAnswers, syncAnswersMarkdown } from "./knowledge/answerStore.js";
import { normalizeQuestion } from "./utils/normalize.js";
import { hasSubmittedBefore, loadApplications, setApplicationStatus } from "./knowledge/applications.js";
import {
  releaseOrphanedClaims,
  claimNextCommand,
  completeCommand,
  releaseCommand,
  type Command,
} from "./knowledge/commands.js";
import { isSubmittedStatus, loadPendingQueue, updatePendingStatus, upsertPending, type PendingEntry } from "./knowledge/approvalQueue.js";
import { loadInternshipList } from "./sources/internshipList.js";
import { loadProfile } from "./knowledge/profile.js";
import { loadX8NoteConfig, syncNoteStage } from "./knowledge/x8note.js";
import { scanEmailForDecisions } from "./knowledge/emailScan.js";
import { writeWorkerStatus } from "./knowledge/workerStatus.js";
import { ensureDir, makeRunDir } from "./utils/log.js";
import type { FilteredJob } from "./types.js";

/**
 * The worker daemon. It owns Chrome and is the ONLY process that writes application state;
 * the web console only enqueues commands. Replaces the 15-minute approvals cron so an action
 * taken in the console happens within seconds.
 *
 * Run: npm run worker   (or via launchd — see install-worker.sh)
 */

loadEnv();

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 10_000);
// The inbox is checked far less often than commands are drained: a scan costs Gmail calls,
// and a reply that waits five minutes has already waited hours. EMAIL_POLL_MS=0 disables it.
const EMAIL_POLL_MS = Number(process.env.EMAIL_POLL_MS ?? 300_000);
const BROWSER_LOCK = path.join(DATA_DIR, ".browser.lock");
const IDLE_CLOSE_MS = Number(process.env.WORKER_IDLE_CLOSE_MS ?? 60_000);

let stopping = false;

/**
 * Whether THIS process currently holds the browser lock. Without it the worker deadlocks
 * against itself: the lock is taken for one command, and the atomic "wx" that makes the lock
 * safe then refuses the NEXT command too — the daemon defers its own work forever, which is
 * exactly what two queued retries did.
 */
let holdsLock = false;

/**
 * Claim the browser. Chrome is single-instance per user-data-dir, so a manual `npm start`
 * and this daemon must never both drive it — a run died mid-job in exactly that situation.
 * "wx" makes the check and the claim one atomic operation.
 */
function acquireBrowserLock(): boolean {
  if (holdsLock) return true; // already ours — re-entrant by design, see holdsLock
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const fd = fs.openSync(BROWSER_LOCK, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    holdsLock = true;
    return true;
  } catch {
    try {
      // A lock left behind by a previous life of this daemon is ours to reclaim — the pid in
      // it is not running any more, so nothing is driving Chrome.
      const owner = Number(fs.readFileSync(BROWSER_LOCK, "utf8").trim());
      const ownerAlive = owner > 0 && owner !== process.pid && isAlive(owner);
      const stat = fs.statSync(BROWSER_LOCK);
      // A stale lock (owner died without releasing) is taken over after 30 minutes.
      if (ownerAlive && Date.now() - stat.mtimeMs < 30 * 60 * 1000) return false;
      fs.writeFileSync(BROWSER_LOCK, String(process.pid));
      holdsLock = true;
      return true;
    } catch {
      return false;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseBrowserLock(): void {
  holdsLock = false;
  try {
    fs.rmSync(BROWSER_LOCK, { force: true });
  } catch {
    /* best effort */
  }
}

let context: BrowserContext | null = null;
let contextIdleSince = Date.now();

/** Launch Chrome only when a command actually needs it, and give the profile back when idle. */
async function withBrowser(): Promise<{ deps: ApplyDeps } | null> {
  if (!acquireBrowserLock()) {
    console.log("worker: browser is busy elsewhere (lock held) — deferring.");
    return null;
  }
  // A context can die while we still hold the object — the hung Aquatic Capital run left one
  // closed, and every command after it failed instantly with "Target page, context or browser has
  // been closed" without ever opening a page. Four approvals were burned that way. Prove the
  // context still works before handing it out.
  if (context) {
    const alive = await context
      .newPage()
      .then(async (page) => {
        await page.close().catch(() => undefined);
        return true;
      })
      .catch(() => false);
    if (!alive) {
      console.log("worker: the browser context is dead — relaunching Chrome.");
      await context.close().catch(() => undefined);
      context = null;
    }
  }
  if (!context) {
    try {
      context = await chromium.launchPersistentContext(AUTH_DIR, {
        channel: "chrome",
        headless: false,
        viewport: { width: 1440, height: 1000 },
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (error) {
      releaseBrowserLock();
      console.log(`worker: could not launch Chrome — ${(error as Error).message.split("\n")[0]}`);
      return null;
    }
  }
  const runDir = makeRunDir();
  await ensureDir(runDir);
  return {
    deps: {
      context,
      profile: await loadProfile(),
      agent: new LlmAgent(),
      x8note: await loadX8NoteConfig(),
      runDir,
    },
  };
}

async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close().catch(() => undefined);
    context = null;
  }
  releaseBrowserLock();
  await writeWorkerStatus({ holdsBrowserLock: false });
}

const findEntry = async (code: string): Promise<PendingEntry | undefined> =>
  (await loadPendingQueue()).find((e) => e.code === code || e.key === code);

async function runCommand(command: Command): Promise<{ ok: boolean; message: string; defer?: boolean }> {
  switch (command.name) {
    case "skip": {
      const entry = await findEntry(command.code);
      if (!entry) return { ok: false, message: `no queue entry for ${command.code}` };
      await upsertPending({ ...entry, status: "skipped", approvedBy: command.actor ?? command.source, decidedAt: new Date().toISOString() });
      return { ok: true, message: `[${command.code}] skipped${command.actor ? ` by ${command.actor}` : ""}` };
    }

    case "manual_submit": {
      // The application is ALREADY IN — filled and submitted by hand on the ATS. Nothing here
      // touches a browser; the only job is to make sure no later run ever re-opens it.
      //
      // That means writing BOTH stores. The queue entry is what the console shows, but every
      // dedupe guard (hasSubmittedBefore, findCrossAtsDuplicate, the sweep's already-engaged
      // check) reads the LEDGER. Marking only the queue would leave the ledger saying
      // "prefilled, never submitted" and the next sweep would re-fill a live application.
      const entry = await findEntry(command.code);
      const applications = await loadApplications();
      const record = applications.find((a) => a.code === command.code || a.id === command.code);
      if (!entry && !record) return { ok: false, message: `no job known as ${command.code}` };

      if (entry && isSubmittedStatus(entry.status) && entry.status !== "manual_submitted") {
        return { ok: false, message: `[${command.code}] is already recorded as ${entry.status} — leaving it alone` };
      }
      if (entry?.status === "submitting") {
        // We clicked submit and never recorded the result. If the user then submitted by hand
        // there may now be two applications, and that is not something to paper over silently.
        return {
          ok: false,
          message: `[${command.code}] is stuck mid-submit from an earlier attempt — check the ATS for a duplicate before marking it manually submitted`,
        };
      }

      const at = new Date().toISOString();
      const who = command.actor ?? command.source;
      const done: string[] = [];

      if (entry) {
        await upsertPending({ ...entry, status: "manual_submitted", approvedBy: who, decidedAt: at });
        done.push("queue");
      }
      if (record) {
        const result = await setApplicationStatus(record.id, "manual_submitted", `submitted manually on the ATS by ${who}`);
        if (result.unchangedBecause) done.push(`ledger unchanged (${result.unchangedBecause})`);
        else if (result.record) {
          done.push("ledger");
          // Keep the note's stage label in step, or statusAudit reports drift for a record
          // that is actually correct. Labels only — there is no new content to store.
          const config = await loadX8NoteConfig();
          if (config && (await syncNoteStage(config, result.record).catch(() => false))) done.push("x8note");
        }
      } else {
        done.push("no ledger record — nothing to dedupe against");
      }

      return {
        ok: true,
        message: `[${command.code}] recorded as manually submitted on the ATS${who ? ` by ${who}` : ""} (${done.join(", ")})`,
      };
    }

    case "approve": {
      const entry = await findEntry(command.code);
      if (!entry) return { ok: false, message: `no queue entry for ${command.code}` };
      if (isSubmittedStatus(entry.status)) {
        return { ok: true, message: `[${command.code}] already ${entry.status === "manual_submitted" ? "submitted by hand on the ATS" : "submitted"} — not submitting again` };
      }
      if (entry.status === "submitting") {
        // A previous attempt clicked submit and never recorded the result. Never retry that
        // automatically — it has to be confirmed on the ATS by a human.
        return { ok: false, message: `[${command.code}] is stuck mid-submit; confirm on the ATS before approving again` };
      }

      // Cross-check the ledger BEFORE opening Chrome. submitApprovedEntry checks this too —
      // that is the load-bearing guard — but doing it here as well means a job that must not
      // be submitted never gets a browser launched at it.
      const applications = await loadApplications();
      if (hasSubmittedBefore(applications, buildJobIdentity(jobFromEntry(entry)))) {
        await updatePendingStatus(entry.key, "submitted", { lastError: "already submitted per local ledger" });
        return { ok: true, message: `[${command.code}] the ledger already records this as submitted — not submitting again` };
      }

      // Persist edited answers BEFORE submitting, so what is recorded as approved is exactly
      // what gets replayed even if the process dies mid-way.
      if (command.answers?.length) {
        await upsertPending({
          ...entry,
          answers: command.answers,
          editedInConsoleAt: new Date().toISOString(),
          editedBy: command.actor ?? command.source,
        });
      }
      await upsertPending({
        ...((await findEntry(command.code)) ?? entry),
        approvedBy: command.actor ?? command.source,
        decidedAt: new Date().toISOString(),
      });

      const started = await withBrowser();
      if (!started) return { ok: false, defer: true, message: "browser busy — deferred, will retry on the next tick" };

      await writeWorkerStatus({
        state: "busy",
        code: command.code,
        activity: `submitting approved [${command.code}] ${entry.company}`,
        holdsBrowserLock: true,
      });

      const fresh = (await findEntry(command.code)) ?? entry;
      const outcome = await submitApprovedEntry(
        fresh,
        { answers: await loadAnswers(), applications, deps: started.deps },
        {
          replayAnswers: command.answers ?? fresh.answers,
          note: command.answers?.length ? "approved in console (answers edited)" : "approved in console",
        },
      );
      // A hold is not a failure — the command ran, and the correct answer was "don't submit".
      // It is reported as ok so the console shows the reason rather than a red FAILED.
      return {
        ok: outcome.result === "submitted" || outcome.result === "already_submitted" || outcome.result === "held_for_reapproval",
        message: outcome.message,
      };
    }

    case "change":
    case "retry": {
      // Re-run a job that stopped before Review — usually because a required question had no
      // answer, and that answer has since been added to the Q&A store — or re-fill an already
      // reviewed one applying a correction ("change"). The two are the same operation: a FILL,
      // never a submit, ending with the job back in the queue awaiting a human decision.
      const applications = await loadApplications();
      const entry = await findEntry(command.code);
      const record = applications.find((a) => a.code === command.code || a.id === command.code);
      // A brand-new posting exists in neither the queue nor the ledger — only in the CSV. It
      // is the most ordinary thing to want to run, and refusing it would mean the terminal and
      // the console can name a job the worker then claims not to know.
      const listed = entry || record ? undefined : (await loadInternshipList().catch(() => [])).find((j) => j.id === command.code);
      if (!entry && !record && !listed) return { ok: false, message: `no job known as ${command.code}` };

      // A retry re-opens a live form, so every "is this already done?" guard applies exactly as
      // it does on the submit path. Re-filling a submitted application risks a second one.
      if (isSubmittedStatus(entry?.status) || record?.status === "submitted" || record?.status === "manual_submitted") {
        return { ok: false, message: `[${command.code}] is already submitted — not re-opening it` };
      }
      if (entry?.status === "submitting") {
        return { ok: false, message: `[${command.code}] is stuck mid-submit; confirm on the ATS before retrying` };
      }
      if (record?.status === "already_applied_on_site") {
        return { ok: false, message: `[${command.code}] was already applied to on the site — not re-opening it` };
      }

      const job: FilteredJob = listed
        ? listed
        : entry
        ? jobFromEntry(entry)
        : {
            company: record!.company,
            title: record!.title,
            location: record!.location ?? "",
            age: "",
            applyUrl: record!.applyUrl,
            id: record!.code,
            region: record!.region,
            usEligible: true,
            needsManualLocationReview: false,
          };
      const identity = buildJobIdentity(job);
      if (hasSubmittedBefore(applications, identity)) {
        return { ok: false, message: `[${command.code}] the ledger records this as submitted — not re-opening it` };
      }

      const started = await withBrowser();
      if (!started) return { ok: false, defer: true, message: "browser busy — deferred, will retry on the next tick" };

      await writeWorkerStatus({
        state: "busy",
        code: command.code,
        activity: `re-filling [${command.code}] ${job.company}`,
        holdsBrowserLock: true,
      });

      // graceMs 0 and mode "fill": fill, reach Review, queue for approval. Nothing is
      // submitted on this path even if an approval is sitting in the inbox.
      const outcome = await applyToJob(job, identity, await loadAnswers(), applications, started.deps, {
        mode: "fill",
        interactive: false,
        graceMs: 0,
        changeInstruction: command.instruction,
        baseNotes: [
          `${command.name === "change" ? "change requested" : "retried"} from console${command.actor ? ` by ${command.actor}` : ""}`,
          ...(command.instruction ? [`instruction: ${command.instruction}`] : []),
        ],
      });

      if (outcome.alreadyApplied) return { ok: true, message: `[${command.code}] already applied on site — nothing to retry` };
      if (outcome.queued) {
        // The re-fill IS the current copy now, so a hold recorded against the previous one is
        // stale — leaving it would show the user differences against answers no longer in play.
        const requeued = await findEntry(command.code);
        if (requeued?.reapproval) await updatePendingStatus(requeued.key, requeued.status, { reapproval: null });
        return { ok: true, message: `[${command.code}] re-filled and queued — review it in the console` };
      }
      if (outcome.reachedReview) return { ok: true, message: `[${command.code}] reached review but was not queued` };
      const why = outcome.blockedRequired?.length
        ? `still blocked on: ${outcome.blockedRequired.join("; ")}`
        : "did not reach review";
      return { ok: false, message: `[${command.code}] ${why}` };
    }

    case "update_answers": {
      // Corrections made while reviewing become the standing answer for that question, so the
      // same mistake is not made on the next twenty applications. This is the whole value of
      // reviewing: the edit is a rule, not a one-off patch.
      if (!command.entries?.length) return { ok: false, message: "no answers to record" };
      let answers = await loadAnswers();
      const learned: string[] = [];
      for (const entry of command.entries) {
        const label = (entry.question ?? "").trim();
        const value = (entry.answer ?? "").trim();
        if (!label || !value) continue;
        answers = await addLearnedAnswer(
          answers,
          {
            label,
            normalizedLabel: normalizeQuestion(label),
            type: "text",
            required: false,
            options: [],
            locatorDescription: label,
          },
          value,
        );
        learned.push(label.length > 48 ? `${label.slice(0, 47)}…` : label);
      }
      await syncAnswersMarkdown(answers);
      return {
        ok: learned.length > 0,
        message: learned.length
          ? `recorded ${learned.length} answer(s) for future applications: ${learned.slice(0, 3).join("; ")}${learned.length > 3 ? ` (+${learned.length - 3})` : ""}`
          : "nothing usable to record",
      };
    }

    case "forget_answers": {
      if (!command.questions?.length) return { ok: false, message: "nothing to forget" };
      const removed = await forgetLearnedAnswers(command.questions);
      return {
        ok: removed.length > 0,
        message: removed.length
          ? `forgot ${removed.length} recorded answer(s): ${removed.slice(0, 3).map((q) => (q.length > 40 ? `${q.slice(0, 39)}…` : q)).join("; ")}`
          : "none of those were recorded answers",
      };
    }

    default:
      return { ok: false, message: `command "${command.name}" is not implemented yet` };
  }
}

let lastEmailScanAt = 0;

/**
 * Read the inbox and turn replies into commands. It never drives the browser itself — that is
 * the whole point of folding it in here: one executor, one lane, one set of guards.
 */
async function scanEmail(): Promise<boolean> {
  if (EMAIL_POLL_MS <= 0) return false;
  if (Date.now() - lastEmailScanAt < EMAIL_POLL_MS) return false;
  lastEmailScanAt = Date.now();
  try {
    const result = await scanEmailForDecisions();
    for (const note of result.notes) console.log(`worker: email — ${note}`);
    for (const item of result.enqueued) {
      console.log(`worker: email — ${item.code} ${item.decision.toUpperCase()} → queued ${item.command}`);
    }
    if (result.enqueued.length) await writeWorkerStatus({ lastError: undefined });
    return result.enqueued.length > 0;
  } catch (error) {
    const message = `email scan failed: ${(error as Error).message.split("\n")[0]}`;
    console.log(`worker: ${message}`);
    await writeWorkerStatus({ lastError: message });
    return false;
  }
}

async function tick(): Promise<void> {
  let didWork = false;
  for (;;) {
    const claimed = await claimNextCommand();
    if (!claimed) break;
    console.log(`worker: ${claimed.command.name} ${JSON.stringify(claimed.command).slice(0, 120)}`);
    let result: { ok: boolean; message: string; defer?: boolean };
    try {
      result = await runCommand(claimed.command);
    } catch (error) {
      result = { ok: false, message: `threw: ${(error as Error).message.split("\n")[0]}` };
      await writeWorkerStatus({ lastError: result.message });
    }
    if (result.defer) {
      // Put it back rather than recording an outcome: the work has not been done, and
      // consuming it here would drop the user's approval while claiming it would retry.
      console.log(`worker:   ⏸ ${result.message}`);
      await releaseCommand(claimed.file);
      break; // stop draining this tick — whatever blocks it blocks the rest too
    }
    didWork = true; // only a COMPLETED command counts; a deferred one must let the idle timer run
    console.log(`worker:   → ${result.ok ? "ok" : "FAILED"}: ${result.message}`);
    await completeCommand(claimed.file, result);
  }

  if (!didWork) await scanEmail();

  if (didWork) contextIdleSince = Date.now();
  // Hand the Chrome profile back when there is nothing to do, so a manual CLI run can use it.
  if (context && Date.now() - contextIdleSince > IDLE_CLOSE_MS) {
    console.log("worker: idle — releasing the browser profile.");
    await closeBrowser();
  }
  await writeWorkerStatus({ state: context ? "busy" : "idle", activity: context ? undefined : "waiting for commands" });
}

async function main(): Promise<void> {
  console.log(`worker: started (pid ${process.pid}), tick ${TICK_MS}ms`);
const freed = await releaseOrphanedClaims();
if (freed.length) console.log(`worker: released ${freed.length} command(s) a previous run had claimed but never finished.`);
  await writeWorkerStatus({ state: "idle", activity: "waiting for commands" });

  // Keep the heartbeat fresh WHILE a command runs. writeWorkerStatus() with no patch only
  // refreshes lastTickAt, so state and activity are preserved. Without this the file is not
  // touched for the whole of a submit — minutes — and the console declares the worker stale
  // during precisely the operation the user is watching.
  const heartbeat = setInterval(() => {
    void writeWorkerStatus();
  }, Math.min(TICK_MS, 10_000));
  heartbeat.unref?.();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
      console.log(`worker: ${sig} — shutting down.`);
    });
  }

  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error("worker: tick failed —", (error as Error).message);
      await writeWorkerStatus({ lastError: (error as Error).message });
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  clearInterval(heartbeat);
  await closeBrowser();
  await writeWorkerStatus({ state: "stopped", activity: "shut down" });
}

main().catch(async (error) => {
  console.error(error);
  await closeBrowser();
  process.exitCode = 1;
});
