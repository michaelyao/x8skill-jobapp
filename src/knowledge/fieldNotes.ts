/**
 * WHAT WE LEARNED ABOUT ONE FIELD ON ONE ATS.
 *
 * The candidate's instruction: "Each time, i give you the feedback, you should remember it against
 * a particular field/ATS, or it is general knowledge on higher layer." This is the per-field,
 * per-ATS half. The general half is guidelines.txt.
 *
 * Every diagnosis in this session was made by hand - cropping a screenshot, reading a DOM dump,
 * noticing that Workable hides its radios behind styled labels or that Uline words a dialling code
 * without parentheses. None of it was written down anywhere the next run could use, so the next
 * run met the same wall.
 *
 * A note is an OBSERVATION, never an instruction to fill something a particular way: the answer
 * still comes from the fact store and the model. It exists so a human - or a later run - can see
 * what this field did last time instead of rediscovering it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export interface FieldNote {
  ats: string;
  /** The field's label as read. Together with `ats` this is the key. */
  label: string;
  /** What was observed - the control's shape, why a fill failed, what the page showed. */
  note: string;
  /** When it was seen, and on which job, so a stale note can be judged. */
  at: string;
  code?: string;
}

const NOTES_PATH = path.join(DATA_DIR, "field-notes.json");

export async function readFieldNotes(): Promise<FieldNote[]> {
  try {
    const raw = await fs.readFile(NOTES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FieldNote[]) : [];
  } catch {
    return [];
  }
}

const key = (ats: string, label: string): string =>
  `${ats.toLowerCase().trim()}::${label.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 90)}`;

/** The note for this field, if one was recorded. */
export function noteFor(notes: readonly FieldNote[], ats: string, label: string): FieldNote | undefined {
  const k = key(ats, label);
  return notes.find((n) => key(n.ats, n.label) === k);
}

/**
 * Record what was observed. One note per field per ATS - the newest wins, because a form that has
 * changed makes the old observation wrong rather than worth keeping.
 */
export async function recordFieldNote(entry: FieldNote): Promise<void> {
  const notes = await readFieldNotes();
  const k = key(entry.ats, entry.label);
  const next = notes.filter((n) => key(n.ats, n.label) !== k);
  next.push(entry);
  // Bounded: this is a diagnostic aid, not an archive.
  const trimmed = next.slice(-500);
  await fs.mkdir(path.dirname(NOTES_PATH), { recursive: true }).catch(() => undefined);
  await fs.writeFile(NOTES_PATH, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
}
