import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { FilledAnswer } from "../agent/types.js";
import { writeJsonAtomic } from "../utils/atomicWrite.js";

/**
 * The command queue: how the web console asks the worker to do something.
 *
 * The console NEVER drives Playwright and never writes application state. It drops an intent
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
  | "change"
  | "retry"
  | "sweep"
  | "refresh_list"
  | "send_review_email"
  | "update_answers";

interface Base {
  id: string;
  createdAt: string; // ISO
  source: string; // "web" | "cli" | ...
  /** Which console account asked for this. With more than one user, "who approved this" has
   *  to be answerable from the record alone. */
  actor?: string;
}

export type Command = Base &
  (
    | {
        name: "approve";
        code: string;
        /** Present when the user edited answers in the console. These BECOME the approved
         *  answers and are what the ReplayAgent replays — "submitted == approved" holds
         *  because the edit happens before approval, not after. */
        answers?: FilledAnswer[];
      }
    | { name: "skip"; code: string }
    | { name: "change"; code: string; instruction: string }
    | { name: "retry"; code: string }
    | { name: "sweep"; jobIds?: string[]; maxJobs?: number; refreshList?: boolean }
    | { name: "refresh_list" }
    | { name: "send_review_email"; code: string }
    | { name: "update_answers"; entries: Array<{ question: string; answer: string }> }
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

/** Queue a command. Written to a temp name then renamed, so the worker never reads a partial file. */
export async function enqueueCommand(cmd: Omit<Command, "id" | "createdAt"> & { source?: string }): Promise<Command> {
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
export async function claimNextCommand(): Promise<ClaimedCommand | null> {
  await ensureDirs();
  const entries = (await fs.readdir(COMMANDS_DIR).catch(() => []))
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();
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

/** Record the outcome and move the command out of the pending set. */
export async function completeCommand(file: string, result: Omit<CommandResult, "finishedAt">): Promise<void> {
  await finish(file, { ...result, finishedAt: new Date().toISOString() });
}

/** Commands still waiting (for the console to show "queued"). */
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

/** Recently completed commands, newest first — the console's activity feed. */
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
