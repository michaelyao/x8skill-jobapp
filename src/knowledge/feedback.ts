import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

/**
 * Notes the reviewer writes ON THE APPLICATION, addressed to whoever is fixing this system.
 *
 * NOT a command. A command tells the worker to do something it already knows how to do; these say
 * "this is wrong, and the reason is probably your code or your data" — which the worker cannot act
 * on at all. Until now the only way to report one was to leave the review page, open a terminal and
 * describe it from memory, which is why most of them were never reported.
 *
 * One file per note, like the command queue: appending to a shared JSON array from the website
 * while a terminal marks notes resolved is a lost update waiting to happen, and a note that
 * disappears is worse than no note.
 *
 * The website WRITES here and nothing else does. Application state stays the worker's alone.
 */
export interface FeedbackNote {
  id: string;
  /** The application this is about. Absent for a note about the system generally. */
  code?: string;
  company?: string;
  title?: string;
  /** What the reviewer typed, verbatim. */
  text: string;
  by: string;
  at: string;
  /** Set when it has been acted on, with what was done. */
  resolvedAt?: string;
  resolution?: string;
}

const FEEDBACK_DIR = path.join(DATA_DIR, "feedback");
const DONE_DIR = path.join(FEEDBACK_DIR, "done");

const rand = (): string => Math.random().toString(36).slice(2, 10);

async function ensureDirs(): Promise<void> {
  await fs.mkdir(DONE_DIR, { recursive: true });
}

/** File a note. Returns it, with the id the reviewer can quote. */
export async function fileFeedback(
  note: Omit<FeedbackNote, "id" | "at" | "resolvedAt" | "resolution">,
): Promise<FeedbackNote> {
  await ensureDirs();
  const full: FeedbackNote = { ...note, id: `${Date.now()}-${rand()}`, at: new Date().toISOString() };
  const name = `${full.at.replace(/[:.]/g, "-")}-${full.id}.json`;
  const tmp = path.join(FEEDBACK_DIR, `.${name}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(full, null, 2), "utf8");
  await fs.rename(tmp, path.join(FEEDBACK_DIR, name));
  return full;
}

/** Open notes, oldest first. `all` includes the ones already dealt with. */
export async function listFeedback(opts: { code?: string; all?: boolean } = {}): Promise<FeedbackNote[]> {
  await ensureDirs();
  const out: FeedbackNote[] = [];
  for (const dir of opts.all ? [FEEDBACK_DIR, DONE_DIR] : [FEEDBACK_DIR]) {
    for (const name of (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith(".json"))) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as FeedbackNote);
      } catch {
        /* a half-written note is not worth failing the list for */
      }
    }
  }
  const filtered = opts.code ? out.filter((n) => (n.code ?? "").toUpperCase() === opts.code!.toUpperCase()) : out;
  return filtered.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Mark a note dealt with, saying what was done about it.
 *
 * Moved rather than deleted: what someone asked for and what was changed in response is the record
 * of why this system is the shape it is, and the commit messages only capture the half I wrote.
 */
export async function resolveFeedback(id: string, resolution: string): Promise<FeedbackNote | undefined> {
  await ensureDirs();
  for (const name of (await fs.readdir(FEEDBACK_DIR).catch(() => [])).filter((n) => n.endsWith(".json"))) {
    const file = path.join(FEEDBACK_DIR, name);
    let note: FeedbackNote;
    try {
      note = JSON.parse(await fs.readFile(file, "utf8")) as FeedbackNote;
    } catch {
      continue;
    }
    if (note.id !== id && !note.id.endsWith(id)) continue;
    const done: FeedbackNote = { ...note, resolvedAt: new Date().toISOString(), resolution };
    await fs.writeFile(path.join(DONE_DIR, name), JSON.stringify(done, null, 2), "utf8");
    await fs.rm(file, { force: true });
    return done;
  }
  return undefined;
}
