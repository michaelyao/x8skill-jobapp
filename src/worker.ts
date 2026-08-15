import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { loadEnv } from "./utils/env.js";
import { AUTH_DIR, DATA_DIR } from "./config.js";
import { LlmAgent } from "./agent/llmAgent.js";
import { buildJobIdentity } from "./core/jobIdentity.js";
import type { ApplyDeps } from "./core/applyJob.js";
import { jobFromEntry, submitApprovedEntry } from "./core/submitApproved.js";
import { loadAnswers } from "./knowledge/answerStore.js";
import { hasSubmittedBefore, loadApplications } from "./knowledge/applications.js";
import {
  claimNextCommand,
  completeCommand,
  releaseCommand,
  type Command,
} from "./knowledge/commands.js";
import { loadPendingQueue, updatePendingStatus, upsertPending, type PendingEntry } from "./knowledge/approvalQueue.js";
import { loadProfile } from "./knowledge/profile.js";
import { loadX8NoteConfig } from "./knowledge/x8note.js";
import { writeWorkerStatus } from "./knowledge/workerStatus.js";
import { ensureDir, makeRunDir } from "./utils/log.js";

/**
 * The worker daemon. It owns Chrome and is the ONLY process that writes application state;
 * the web console only enqueues commands. Replaces the 15-minute approvals cron so an action
 * taken in the console happens within seconds.
 *
 * Run: npm run worker   (or via launchd — see install-worker.sh)
 */

loadEnv();

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 10_000);
const BROWSER_LOCK = path.join(DATA_DIR, ".browser.lock");
const IDLE_CLOSE_MS = Number(process.env.WORKER_IDLE_CLOSE_MS ?? 60_000);

let stopping = false;

/**
 * Claim the browser. Chrome is single-instance per user-data-dir, so a manual `npm start`
 * and this daemon must never both drive it — a run died mid-job in exactly that situation.
 * "wx" makes the check and the claim one atomic operation.
 */
function acquireBrowserLock(): boolean {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const fd = fs.openSync(BROWSER_LOCK, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const stat = fs.statSync(BROWSER_LOCK);
      // A stale lock (owner died without releasing) is taken over after 30 minutes.
      if (Date.now() - stat.mtimeMs < 30 * 60 * 1000) return false;
      fs.writeFileSync(BROWSER_LOCK, String(process.pid));
      return true;
    } catch {
      return false;
    }
  }
}

function releaseBrowserLock(): void {
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

    case "approve": {
      const entry = await findEntry(command.code);
      if (!entry) return { ok: false, message: `no queue entry for ${command.code}` };
      if (entry.status === "submitted") return { ok: true, message: `[${command.code}] already submitted` };
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
      return { ok: outcome.result === "submitted" || outcome.result === "already_submitted", message: outcome.message };
    }

    default:
      return { ok: false, message: `command "${command.name}" is not implemented yet` };
  }
}

async function tick(): Promise<void> {
  let didWork = false;
  for (;;) {
    const claimed = await claimNextCommand();
    if (!claimed) break;
    didWork = true;
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
