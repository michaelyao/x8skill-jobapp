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
import { planSweep } from "./core/selectJobs.js";
import {
  enqueueCommand,
  releaseOrphanedClaims,
  claimNextCommand,
  completeCommand,
  releaseCommand,
  type Command,
} from "./knowledge/commands.js";
import { isSubmittedStatus, loadPendingQueue, setVisualCheck, updatePendingStatus, upsertPending, type PendingEntry } from "./knowledge/approvalQueue.js";
import { evaluateScreen } from "./knowledge/visualCheck.js";
import { loadInternshipList, refreshInternshipCsv } from "./sources/internshipList.js";
import { loadProfile } from "./knowledge/profile.js";
import { loadX8NoteConfig, syncNoteStage } from "./knowledge/x8note.js";
import { writeWorkerStatus } from "./knowledge/workerStatus.js";
import { ensureDir, makeRunDir } from "./utils/log.js";
import type { FilteredJob } from "./types.js";

/**
 * The worker daemon. It owns Chrome and is the ONLY process that writes application state;
 * the web website only enqueues commands. Replaces the 15-minute approvals cron so an action
 * taken in the website happens within seconds.
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
          note: command.answers?.length ? "approved in website (answers edited)" : "approved in website",
        },
      );
      // A hold is not a failure — the command ran, and the correct answer was "don't submit".
      // It is reported as ok so the website shows the reason rather than a red FAILED.
      return {
        ok: outcome.result === "submitted" || outcome.result === "already_submitted" || outcome.result === "held_for_reapproval",
        message: outcome.message,
      };
    }

    case "refresh_list": {
      // Rebuild the job list from job_sites.txt. Two of the three sources are plain HTTP;
      // interndock is JS-rendered, so the builder launches its OWN throwaway headless Chromium
      // for it. That is not the persistent auth profile and takes no browser lock — but it is
      // still a browser, which is why this runs here and not in the container.
      const before = (await loadInternshipList().catch(() => [])).length;
      await writeWorkerStatus({ state: "busy", activity: "rebuilding the job list" });
      await refreshInternshipCsv();
      const after = (await loadInternshipList().catch(() => [])).length;
      const delta = after - before;
      return {
        ok: true,
        message: `job list rebuilt: ${after} listing(s)${delta === 0 ? " (unchanged)" : delta > 0 ? `, ${delta} new` : `, ${-delta} fewer`}`,
      };
    }

    case "visual_check": {
      /**
       * An x8ocr job came back. Evaluate it HERE — the website only carried the text across,
       * because this process is the only writer of pending-approvals.json.
       *
       * The entry may be gone or already replaced: a re-fill during OCR produces a new
       * screenshot and its own job, and applying a verdict about the old screen to the new
       * entry would be worse than applying nothing. setVisualCheck returns false when the
       * entry has vanished; the jobId comparison covers the replaced case.
       */
      const entry = await findEntry(command.code);
      if (!entry) return { ok: true, message: `[${command.code}] no queue entry left to verify — verdict dropped` };
      if (command.jobId && entry.visualCheck?.jobId && entry.visualCheck.jobId !== command.jobId) {
        return { ok: true, message: `[${command.code}] verdict is for a superseded screenshot (${command.jobId}) — dropped` };
      }
      const at = new Date().toISOString();

      if (command.failed || !command.screenText?.trim()) {
        await setVisualCheck(entry.key, { state: "unavailable", jobId: command.jobId, at });
        return { ok: true, message: `[${command.code}] visual cross-check unavailable (${command.failed ?? "no text"}) — not blocking` };
      }

      const gaps = evaluateScreen(
        command.screenText,
        (entry.answers ?? []).map((a) => ({ label: a.label, value: a.value })),
        { blocks: command.blocks as never, capability: command.capability as never },
      );
      if (gaps.length) {
        await setVisualCheck(entry.key, { state: "gaps", gaps, jobId: command.jobId, at });

        /**
         * HAND IT BACK TO THE FILLER instead of waiting to be noticed.
         *
         * A gap that says the form REQUIRES something we never recorded is not a judgement call —
         * it is work the run did not finish, and the reviewer should not be the mechanism that
         * discovers it. Re-fill once, telling the filler exactly which questions the screen says
         * are missing; the reader has usually been taught to see them by then.
         *
         * ONCE. A re-fill produces a new screenshot and a new check, so retrying on every verdict
         * would loop an application against a live employer form indefinitely. `autoRefilled` marks
         * that this entry has already had its free attempt.
         */
        const missing = gaps.filter((g) => /REQUIRED and nothing was recorded/.test(g));
        if (missing.length && !entry.autoRefilled) {
          await updatePendingStatus(entry.key, entry.status, { autoRefilled: true });
          await enqueueCommand({
            name: "retry",
            code: command.code,
            instruction: `The review screenshot shows these REQUIRED questions with nothing recorded — answer them: ${missing
              .map((m) => m.replace(/^the form marks "|" REQUIRED and nothing was recorded for it$/g, ""))
              .join("; ")}`,
            source: "visual-check",
            actor: "auto",
          });
          return {
            ok: true,
            message: `[${command.code}] the screen shows ${missing.length} REQUIRED question(s) with no answer — re-filling once:\n${gaps
              .map((g) => `     • ${g}`)
              .join("\n")}`,
          };
        }
        return {
          ok: true,
          message: `[${command.code}] the screen does not match what was recorded — submit is blocked:\n${gaps.map((g) => `     • ${g}`).join("\n")}`,
        };
      }
      await setVisualCheck(entry.key, { state: "clean", jobId: command.jobId, at });
      return { ok: true, message: `[${command.code}] visual cross-check: every recorded value is on the screen` };
    }

    case "sweep": {
      // Decide what to apply to, then enqueue ONE apply command per job. No browser here.
      //
      // The queue is the pacing mechanism. Applying inline would mean a sweep holds Chrome for
      // however long ten applications take, with a decision you make in the meantime stuck
      // behind it — the problem "your decisions jump the queue" fixed. As separate commands,
      // each apply is one claimable unit and an approve outranks all of them.
      if (command.refreshList) {
        await enqueueCommand({ name: "refresh_list", source: `sweep:${command.source}`, actor: command.actor });
      }

      const plan = await planSweep({
        jobIds: command.jobIds,
        maxJobs: command.maxJobs,
        supportedOnly: command.supportedOnly,
        latestFirst: command.latestFirst,
        forceRetry: command.forceRetry,
      });

      for (const job of plan.selected) {
        if (!job.id) continue; // apply addresses a job by its CSV code
        await enqueueCommand({ name: "apply", code: job.id, source: `sweep:${command.source}`, actor: command.actor });
      }

      const queued = plan.selected.filter((j) => j.id).length;
      const why = new Map<string, number>();
      for (const s of plan.skipped) why.set(s.reason, (why.get(s.reason) ?? 0) + 1);
      const detail = [...why.entries()].map(([reason, n]) => `${n} ${reason}`).join(", ");
      return {
        ok: true,
        message:
          `swept ${plan.considered} listing(s) → queued ${queued} application(s)` +
          (plan.heldBackByCap ? `, ${plan.heldBackByCap} held back by the cap` : "") +
          (detail ? ` (skipped: ${detail})` : "") +
          (command.refreshList ? " · list refresh queued first" : ""),
      };
    }

    case "apply":
    case "change":
    case "retry": {
      // Apply to a job, or re-run one that stopped before Review (usually because a required
      // question had no answer, and that answer has since been added), or re-fill a reviewed
      // one applying a correction ("change"). All three are the same operation: a FILL, never
      // a submit, ending with the job in the queue awaiting a human decision. Sharing one
      // handler is deliberate — every "is this already done?" guard below then exists once.
      const applications = await loadApplications();
      const entry = await findEntry(command.code);
      const record = applications.find((a) => a.code === command.code || a.id === command.code);
      // A brand-new posting exists in neither the queue nor the ledger — only in the CSV. It
      // is the most ordinary thing to want to run, and refusing it would mean the terminal and
      // the website can name a job the worker then claims not to know.
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
        activity: `${command.name === "apply" ? "filling" : "re-filling"} [${command.code}] ${job.company}`,
        holdsBrowserLock: true,
      });

      // mode "fill": fill, reach Review, queue for approval. Nothing is
      // submitted on this path even if an approval is sitting in the inbox.
      const outcome = await applyToJob(job, identity, await loadAnswers(), applications, started.deps, {
        mode: "fill",
        interactive: false,
        changeInstruction: command.instruction,
        baseNotes: [
          `${command.name === "change" ? "change requested" : command.name === "apply" ? "applied" : "retried"} from ${command.source}${command.actor ? ` by ${command.actor}` : ""}`,
          ...(command.instruction ? [`instruction: ${command.instruction}`] : []),
        ],
      });

      if (outcome.alreadyApplied) return { ok: true, message: `[${command.code}] already applied on site — nothing to retry` };
      if (outcome.queued) {
        // The re-fill IS the current copy now, so a hold recorded against the previous one is
        // stale — leaving it would show the user differences against answers no longer in play.
        const requeued = await findEntry(command.code);
        if (requeued?.reapproval) await updatePendingStatus(requeued.key, requeued.status, { reapproval: null });
        return { ok: true, message: `[${command.code}] re-filled and queued — review it in the website` };
      }
      if (outcome.reachedReview) return { ok: true, message: `[${command.code}] reached review but was not queued` };
      // A closed posting is a correct outcome, not a failure. applyJob already detects it, records
      // `expired` in the ledger and skips — but this reported it as "did not reach review", so 19
      // of the 82 entries in the failure list were listings that simply no longer exist. That
      // buries the real failures and invites debugging a filling bug that is not there.
      if (outcome.summaryItem?.outcome === "expired") {
        return { ok: true, message: `[${command.code}] posting is closed — recorded as expired, will not be re-opened` };
      }
      /**
       * Say WHERE it stopped. "did not reach review" on its own is the failure this codebase keeps
       * warning about: two Uline applications failed with that line and nothing else — no fields, no
       * screenshot, an empty run directory — which is indistinguishable from a filling bug and is
       * not one. applyJob already collects the reason in summaryItem.notes; it was simply never read.
       */
      /**
       * The REASON, not the transcript of what went right. `notes` carries the whole "filled X: Y"
       * list, so taking the first three turned a 105-field run that stopped on a stuck Terms &
       * Conditions checkbox into "did not reach review — filled First Name: Nathan; filled Last
       * Name: Yao", which reads like it stopped after two fields. Eight runs in one batch looked
       * like that.
       */
      const notes = (outcome.summaryItem?.notes ?? [])
        .filter(Boolean)
        .filter((n) => !/^filled /i.test(n));
      const why = outcome.blockedRequired?.length
        ? `still blocked on: ${outcome.blockedRequired.join("; ")}`
        : notes.length
          ? `did not reach review — ${notes.slice(0, 3).join("; ")}`
          : `did not reach review after filling ${outcome.summaryItem?.notes?.filter((n) => /^filled /i.test(n)).length ?? 0} field(s) — see the run log for the last control it could not pass`;
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

    default: {
      // Unreachable by type: every member of the Command union is handled above. Kept because
      // commands arrive as JSON files on disk, so a name this build does not know is possible —
      // an older file, or a hand-written one.
      const unrecognised = command as { name?: unknown };
      return { ok: false, message: `unrecognised command "${String(unrecognised.name)}"` };
    }
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
  // touched for the whole of a submit — minutes — and the website declares the worker stale
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
