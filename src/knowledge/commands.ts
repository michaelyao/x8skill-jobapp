import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { FilledAnswer } from "../agent/types.js";
import { writeJsonAtomic } from "../utils/atomicWrite.js";

/**
 * The command queue: how the web website asks the worker to do something.
 *
 * The website NEVER drives Playwright and never writes application state. It drops an intent
 * here; the worker — the only process that owns Chrome and the only writer of
 * applications.json / pending-approvals.json / Q&A.txt — picks it up. That single-writer
 * split is what keeps two processes from racing on the same JSON, which has corrupted state
 * in this project before.
 *
 * One file per command, claimed by rename (atomic on POSIX), so a crash mid-command leaves a
 * visible artefact instead of a half-applied action.
 */

export const COMMANDS_DIR = path.join(DATA_DIR, "commands");
export const COMMANDS_DONE_DIR = path.join(COMMANDS_DIR, "done");

export type CommandName =
  | "approve"
  | "skip"
  | "manual_submit"
  | "apply"
  | "change"
  | "retry"
  | "sweep"
  | "refresh_list"
  | "update_answers"
  | "visual_check";

interface Base {
  id: string;
  createdAt: string; // ISO
  source: string; // "web" | "cli" | ...
  /** Which website account asked for this. With more than one user, "who approved this" has
   *  to be answerable from the record alone. */
  actor?: string;
}

export type Command = Base &
  (
    | {
        name: "approve";
        code: string;
        /** Present when the user edited answers in the website. These BECOME the approved
         *  answers and are what the ReplayAgent replays — "submitted == approved" holds
         *  because the edit happens before approval, not after. */
        answers?: FilledAnswer[];
      }
    | { name: "skip"; code: string }
    | {
        /**
         * The user filled and submitted this application themselves on the ATS. Records that
         * it WENT IN, so no later run re-opens it — the opposite of a skip, which records that
         * no application exists.
         */
        name: "manual_submit";
        code: string;
        /** Optional free-text note, kept on the ledger record. */
        note?: string;
      }
    | { name: "change"; code: string; instruction: string }
    | {
        name: "retry";
        code: string;
        /** Optional steer for the re-fill ("the school is Carnegie Mellon"), applied the same
         *  way an emailed change request is. A plain retry sends nothing. */
        instruction?: string;
      }
    | {
        /**
         * Apply to one job: open the form, fill it, stop at Review, queue it for approval.
         * NEVER submits. Identical operation to "retry" — same handler, because a fresh job
         * and a re-run differ only in whether we have seen it before.
         */
        name: "apply";
        code: string;
        /** Optional steer for the fill, applied the way a change request is. */
        instruction?: string;
      }
    | {
        /**
         * Choose the next jobs and enqueue one "apply" per job. Does NOT touch a browser: the
         * apply commands do, one at a time, which is what keeps a sweep of ten jobs from
         * becoming ten Chromes.
         */
        name: "sweep";
        jobIds?: string[];
        /** Defaults to DEFAULT_SWEEP_CAP (10). */
        maxJobs?: number;
        /** Rebuild the job list first (as a separate refresh_list command). */
        refreshList?: boolean;
        supportedOnly?: boolean;
        latestFirst?: boolean;
        forceRetry?: boolean;
      }
    | {
        /**
         * An x8ocr job finished and this is what the screen said. Enqueued by the website's
         * /api/ocr-result callback receiver; applied here because the worker is the only
         * writer of pending-approvals.json. The website deliberately does not evaluate the
         * text or touch the entry — it only carries the result across.
         */
        name: "visual_check";
        code: string;
        /** x8ocr job id, for tracing a result back to its submission. */
        jobId?: string;
        /** Page text as x8ocr read it. Empty/absent means the OCR produced nothing. */
        screenText?: string;
        /** Set when the OCR job itself failed; the check is then recorded as unavailable. */
        failed?: string;
      }
    | { name: "refresh_list" }
    | { name: "update_answers"; entries: Array<{ question: string; answer: string }> }
    | { name: "forget_answers"; questions: string[] }
  );

export interface CommandResult {
  ok: boolean;
  message: string;
  finishedAt: string;
}

const rand = () => Math.random().toString(36).slice(2, 10);

async function ensureDirs(): Promise<void> {
  await fs.mkdir(COMMANDS_DONE_DIR, { recursive: true });
}

/**
 * A command as the caller supplies it: everything but the fields we stamp.
 *
 * Distributed over the union deliberately. A plain `Omit<Command, …>` collapses a discriminated
 * union to just its COMMON keys, so `{ name: "apply", code }` failed to type-check and every
 * caller worked around it with `as never` — which also silenced real mistakes.
 *
 * The Enqueueable helper exists because a conditional type only distributes over a NAKED type
 * parameter; writing the conditional on `Command` directly does nothing.
 */
type Enqueueable<C> = C extends unknown ? Omit<C, "id" | "createdAt"> & { source?: string } : never;
export type NewCommand = Enqueueable<Command>;

/** Queue a command. Written to a temp name then renamed, so the worker never reads a partial file. */
export async function enqueueCommand(cmd: NewCommand): Promise<Command> {
  await ensureDirs();
  const full = {
    ...cmd,
    id: `${Date.now()}-${rand()}`,
    createdAt: new Date().toISOString(),
    source: cmd.source ?? "web",
  } as Command;
  // Sortable filename: the worker drains oldest-first.
  const name = `${full.createdAt.replace(/[:.]/g, "-")}-${full.id}.json`;
  // fsynced before the rename: "approve this application" is consequential enough that it
  // must survive a crash between the click and the worker picking it up.
  await writeJsonAtomic(path.join(COMMANDS_DIR, name), full);
  return full;
}

export interface ClaimedCommand {
  command: Command;
  /** The claimed path — pass back to completeCommand. */
  file: string;
}

/**
 * Claim the oldest pending command. The rename is the claim: if two workers ever ran, only
 * one rename succeeds, so a command cannot be executed twice.
 */
/**
 * Your decisions come first.
 *
 * Commands used to run strictly in the order they arrived, which meant an approve could sit behind
 * a batch of re-fills for hours — it already happened once, with four approvals waiting on a single
 * stuck job. A decision takes seconds and is the thing you are waiting on; a re-fill is background
 * work. Within a class, oldest first as before.
 */
const PRIORITY: Record<string, number> = {
  approve: 0,
  skip: 0,
  // A decision, like approve and skip: it takes no browser and the user is waiting on it.
  manual_submit: 0,
  // Same class, for the same two reasons: it is a JSON evaluation and a file write (no browser),
  // and its verdict GATES the submit — an approved application sits unsent until this lands. Left
  // to the default rank of 2 it would queue behind a `change`, and behind whatever fill is already
  // running, which can be twenty minutes. Declared rather than defaulted: an implicit priority for
  // something on the submit path is the kind of silent choice that goes wrong here.
  visual_check: 0,
  update_answers: 1,
  forget_answers: 1,
  change: 2,
  retry: 3,
  // Background work, same class as retry: a sweep enqueues these and they take minutes each.
  apply: 3,
  refresh_list: 4,
  sweep: 4,
};
const rank = (name: string): number => PRIORITY[name] ?? 2;

/**
 * Release commands a dead worker had claimed.
 *
 * A claim is a rename to ".claimed"; only the running worker renames it back. Kill it mid-command —
 * as a restart does — and the file is stranded forever: two of yours sat unclaimed and unrun with no
 * sign of it anywhere. Called on startup, when by definition nothing is in flight.
 */
export async function releaseOrphanedClaims(): Promise<string[]> {
  await ensureDirs();
  const names = (await fs.readdir(COMMANDS_DIR).catch(() => [])).filter((f) => f.endsWith(".json.claimed"));
  const freed: string[] = [];
  for (const name of names) {
    const from = path.join(COMMANDS_DIR, name);
    const to = path.join(COMMANDS_DIR, name.replace(/\.claimed$/, ""));
    try {
      await fs.rename(from, to);
      freed.push(name.replace(/\.claimed$/, ""));
    } catch {
      /* leave it; the next start will try again */
    }
  }
  return freed;
}

export async function claimNextCommand(): Promise<ClaimedCommand | null> {
  await ensureDirs();
  const names = (await fs.readdir(COMMANDS_DIR).catch(() => []))
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();
  // Read the name off each file to order by class. A file that cannot be read keeps its place in
  // the queue and fails in the loop below, where the failure is recorded.
  const ordered: Array<{ name: string; rank: number }> = [];
  for (const name of names) {
    let commandName = "";
    try {
      commandName = (JSON.parse(await fs.readFile(path.join(COMMANDS_DIR, name), "utf8")) as Command).name;
    } catch {
      /* unreadable — treat as middling priority and let the claim loop report it */
    }
    ordered.push({ name, rank: rank(commandName) });
  }
  const entries = ordered.sort((a, b) => a.rank - b.rank).map((e) => e.name);

  for (const name of entries) {
    const from = path.join(COMMANDS_DIR, name);
    const claimed = `${from}.claimed`;
    try {
      await fs.rename(from, claimed);
    } catch {
      continue; // someone else got it, or it vanished
    }
    try {
      const command = JSON.parse(await fs.readFile(claimed, "utf8")) as Command;
      return { command, file: claimed };
    } catch (error) {
      await finish(claimed, { ok: false, message: `unreadable: ${(error as Error).message}`, finishedAt: new Date().toISOString() });
    }
  }
  return null;
}

async function finish(file: string, result: CommandResult): Promise<void> {
  const base = path.basename(file).replace(/\.claimed$/, "");
  const target = path.join(COMMANDS_DONE_DIR, base);
  try {
    const body = JSON.parse(await fs.readFile(file, "utf8"));
    await writeJsonAtomic(target, { ...body, result });
    await fs.rm(file, { force: true });
  } catch {
    await fs.rename(file, target).catch(() => undefined);
  }
}

/**
 * Put a claimed command BACK in the pending set, unexecuted.
 *
 * For deferrals — "the browser is busy right now" is not an outcome, it is a "not yet".
 * Completing it instead silently threw away the user's intent while telling them it would be
 * retried, so an approval could vanish with no trace but a done/ file saying it was fine.
 */
export async function releaseCommand(file: string): Promise<void> {
  const original = file.replace(/\.claimed$/, "");
  await fs.rename(file, original).catch(() => undefined);
}

/** Record the outcome and move the command out of the pending set. */
export async function completeCommand(file: string, result: Omit<CommandResult, "finishedAt">): Promise<void> {
  await finish(file, { ...result, finishedAt: new Date().toISOString() });
}

/** Commands still waiting (for the website to show "queued"). */
export async function pendingCommands(): Promise<Command[]> {
  await ensureDirs();
  const names = (await fs.readdir(COMMANDS_DIR).catch(() => [])).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
  const out: Command[] = [];
  for (const n of names.sort()) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(COMMANDS_DIR, n), "utf8")) as Command);
    } catch {
      /* mid-write; it will be there next poll */
    }
  }
  return out;
}

/** Recently completed commands, newest first — the website's activity feed. */
export async function recentCommands(limit = 25): Promise<Array<Command & { result?: CommandResult }>> {
  await ensureDirs();
  const names = (await fs.readdir(COMMANDS_DONE_DIR).catch(() => [])).filter((f) => f.endsWith(".json")).sort().reverse();
  const out: Array<Command & { result?: CommandResult }> = [];
  for (const n of names.slice(0, limit)) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(COMMANDS_DONE_DIR, n), "utf8")));
    } catch {
      /* skip */
    }
  }
  return out;
}
