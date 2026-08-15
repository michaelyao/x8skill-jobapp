import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { writeJsonAtomic } from "../utils/atomicWrite.js";
import type { FieldSpec, FilledAnswer } from "../agent/types.js";

/**
 * Every time the automation reads a job's form, the form it saw is recorded here.
 *
 * Approval can take days, so the form at submit time is not necessarily the form that was
 * approved. When a replay then fails, "the form changed" must be a FACT the user can check,
 * not a claim I make — so both copies are kept and diffed, and the failure cites the diff.
 *
 * Rounds are append-only and never overwritten: data/rounds/<CODE>/<ISO>-<phase>.json
 */

export const ROUNDS_DIR = path.join(DATA_DIR, "rounds");

export type RoundPhase = "fill" | "submit" | "refill";

export interface RoundField {
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

export interface Round {
  code: string;
  phase: RoundPhase;
  at: string; // ISO
  url: string;
  /** Every field the reader saw, in DOM order, across all turns of that visit. */
  fields: RoundField[];
  /** What was actually entered (fill), or replayed (submit). */
  answers: Array<{ label: string; value: string; draft?: boolean }>;
  outcome?: string;
  actor?: string;
}

const slug = (code: string) => code.replace(/[^A-Za-z0-9_-]/g, "_");

export async function saveRound(round: Omit<Round, "at"> & { at?: string }): Promise<string> {
  const at = round.at ?? new Date().toISOString();
  const dir = path.join(ROUNDS_DIR, slug(round.code));
  const file = path.join(dir, `${at.replace(/[:.]/g, "-")}-${round.phase}.json`);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(file, { ...round, at });
  return file;
}

export async function listRounds(code: string): Promise<Round[]> {
  const dir = path.join(ROUNDS_DIR, slug(code));
  const names = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  const out: Round[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Round);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export interface RoundDiff {
  added: RoundField[]; // on the form now, absent when approved
  removed: RoundField[]; // approved against, gone now
  requiredChanged: Array<{ label: string; was: boolean; now: boolean }>;
  /** Labels that look like a rewording of one another: same start, different tail. */
  reworded: Array<{ before: string; after: string; divergesAt: number }>;
  unchanged: number;
}

const key = (label: string) => label.toLowerCase().replace(/\s+/g, " ").trim();
const markerless = (label: string) => key(label).replace(/[*✱٭]+/g, " ").replace(/\s+/g, " ").trim();

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
  return i;
}

/**
 * What changed between the form that was approved and the form seen now. Reported verbatim —
 * a rewording is presented as the two strings and where they diverge, so the user can judge
 * it rather than take my word for it.
 */
export function diffRounds(approved: Round, current: Round): RoundDiff {
  const beforeByKey = new Map(approved.fields.map((f) => [markerless(f.label), f]));
  const afterByKey = new Map(current.fields.map((f) => [markerless(f.label), f]));

  const added = current.fields.filter((f) => !beforeByKey.has(markerless(f.label)));
  const removed = approved.fields.filter((f) => !afterByKey.has(markerless(f.label)));

  const requiredChanged: RoundDiff["requiredChanged"] = [];
  let unchanged = 0;
  for (const f of current.fields) {
    const was = beforeByKey.get(markerless(f.label));
    if (!was) continue;
    if (was.required !== f.required) requiredChanged.push({ label: f.label, was: was.required, now: f.required });
    else unchanged += 1;
  }

  // Pair up an added field with a removed one when they share a long prefix — that is a
  // rewording, not an unrelated new question.
  const reworded: RoundDiff["reworded"] = [];
  for (const a of added) {
    for (const r of removed) {
      const n = commonPrefix(key(r.label), key(a.label));
      if (n >= 25) reworded.push({ before: r.label, after: a.label, divergesAt: n });
    }
  }

  return { added, removed, requiredChanged, reworded, unchanged };
}

/** One-line summaries suitable for an error message or the console. */
export function describeDiff(diff: RoundDiff): string[] {
  const lines: string[] = [];
  for (const r of diff.reworded) {
    lines.push(`reworded: "${r.before}" → "${r.after}" (differs from character ${r.divergesAt})`);
  }
  const rewordedLabels = new Set(diff.reworded.flatMap((r) => [markerless(r.before), markerless(r.after)]));
  for (const f of diff.added) {
    if (!rewordedLabels.has(markerless(f.label))) lines.push(`new field${f.required ? " (required)" : ""}: "${f.label}"`);
  }
  for (const f of diff.removed) {
    if (!rewordedLabels.has(markerless(f.label))) lines.push(`no longer on the form: "${f.label}"`);
  }
  for (const c of diff.requiredChanged) {
    lines.push(`${c.now ? "became required" : "no longer required"}: "${c.label}"`);
  }
  return lines;
}
