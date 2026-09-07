import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { normalizeQuestion } from "../utils/normalize.js";

/**
 * WHAT WE HAVE LEARNED ABOUT A QUESTION, keyed on the QUESTION rather than the job.
 *
 * The candidate's complaint, and it is the right one:
 *
 *   "even for same ATS, the different job will have some kind of variant of the way to ask the same
 *    or similar question. The answer could be in the multiple layer of dropdown, or a list of
 *    checkbox, etc."
 *
 * `field-notes.json` already remembers what to try when a control refuses a value, but it is keyed
 * on (ats, label) and its label is the one THIS form used. A second employer asking the same thing
 * with a comma moved learns nothing from the first. So the key is the normalised question —
 * `normalizeQuestion` already strips list numbering, quotes, parentheticals and the company's own
 * name, which is exactly the noise that makes two identical questions look different.
 *
 * THE ONE DISTINCTION THIS FILE EXISTS TO ENFORCE: an ANSWER travels and a MECHANISM does not.
 *
 * "Have you ever worked for us? — No" is true at every employer, on every widget, forever. How to
 * make a particular widget accept it is a property of that tenant's markup and says nothing about
 * anyone else's: CLAUDE.md already forbids carrying a field note across ATSes, and that rule is
 * about mechanism. Conflating the two would either lose answers we have been given or apply a
 * Workday click recipe to a Greenhouse radio.
 *
 * So `recallAnswer` looks across every ATS and every shape, and `recallMechanism` refuses to leave
 * its own ats+shape.
 */

/** The widget family a mechanism belongs to. A recipe is only ever valid within one of these. */
export type WidgetShape =
  | "workday-prompt"
  | "react-select"
  | "select"
  | "radio"
  | "checkbox-group"
  | "checkbox"
  | "text"
  | "unknown";

/**
 * The widget family a FieldSpec belongs to, derived in ONE place.
 *
 * A mechanism is only valid within a shape, so this is the other half of the memory key. Kept here
 * beside `WidgetShape` rather than inlined at each call site — two slightly different mappings
 * would silently split one question's memory into two.
 */
export function shapeOfField(field: {
  type?: string;
  widget?: string;
  options?: readonly string[];
  groupKey?: string;
}): WidgetShape {
  if (field.widget === "workday-select") return "workday-prompt";
  if (field.widget === "react-select") return "react-select";
  switch (field.type) {
    case "single_select":
    case "multi_select":
      return "select";
    case "radio":
      return "radio";
    case "checkbox":
      return field.groupKey ? "checkbox-group" : "checkbox";
    case "text":
    case "textarea":
      return "text";
    default:
      return "unknown";
  }
}

export interface QuestionMemory {
  /** `normalizeQuestion(label)` — the question, stripped of the wording each form gives it. */
  fingerprint: string;
  /** One real label that produced this fingerprint, so the file can be read by a person. */
  sampleLabel: string;
  ats: string;
  shape: WidgetShape;
  /**
   * HOW to interact — the recipe that committed, or the rows to click in order.
   * Valid only within this ats+shape. Absent on an answer-only memory.
   */
  mechanism?: { recipe?: string; path?: string[] };
  /**
   * WHAT to answer. Travels everywhere. Absent on a mechanism-only memory.
   */
  answer?: string;
  /** `candidate` outranks `learned`: he told us, we did not work it out. */
  source: "learned" | "candidate";
  /** Did it actually commit? A remedy that did not is recorded so it is never tried again. */
  worked: boolean;
  at: string;
  /** How many times this memory has been used. The reason to trust it, and to budget by it. */
  hits: number;
}

const MEMORY_PATH = path.join(DATA_DIR, "question-memory.json");

export function fingerprintOf(label: string): string {
  return normalizeQuestion(label ?? "").trim();
}

export function memoryKey(label: string, ats: string, shape: WidgetShape): string {
  return `${fingerprintOf(label)}||${ats}||${shape}`;
}

export async function readQuestionMemory(): Promise<QuestionMemory[]> {
  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf8");
    const parsed = JSON.parse(raw) as QuestionMemory[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The recipe or path that committed for THIS question on THIS ats and THIS widget shape.
 *
 * Deliberately narrow. A mechanism is a fact about a tenant's markup; the same question on another
 * ATS, or the same ATS with a different widget, is a different problem and gets none of this.
 * Only a memory that WORKED is returned — one that failed is still consulted, by
 * `mechanismFailed`, so the loop does not spend its budget re-trying it.
 */
export function recallMechanism(
  memories: readonly QuestionMemory[],
  label: string,
  ats: string,
  shape: WidgetShape,
): QuestionMemory | undefined {
  const key = memoryKey(label, ats, shape);
  return memories
    .filter((m) => m.mechanism && m.worked && memoryKey(m.sampleLabel, m.ats, m.shape) === key)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

/** Recipes already known NOT to work here, so the experiment loop skips them. */
export function mechanismsRuledOut(
  memories: readonly QuestionMemory[],
  label: string,
  ats: string,
  shape: WidgetShape,
): string[] {
  const key = memoryKey(label, ats, shape);
  return memories
    .filter((m) => !m.worked && m.mechanism?.recipe && memoryKey(m.sampleLabel, m.ats, m.shape) === key)
    .map((m) => m.mechanism!.recipe!);
}

/**
 * The answer to this question, from anywhere.
 *
 * Crosses ATS and widget freely, because that is what an answer is. His own words on why this
 * exists: "once i answered, they need remember this type of question, as their knowledge, and use
 * it again if they see the similar question."
 *
 * What he told us beats what we worked out, and the most recent of those wins — a correction is
 * meant to override.
 */
export function recallAnswer(
  memories: readonly QuestionMemory[],
  label: string,
): QuestionMemory | undefined {
  const fingerprint = fingerprintOf(label);
  if (!fingerprint) return undefined;
  return memories
    .filter((m) => m.answer !== undefined && m.fingerprint === fingerprint)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === "candidate" ? -1 : 1;
      return Date.parse(b.at) - Date.parse(a.at);
    })[0];
}

/**
 * Write one memory, replacing any earlier one with the same key AND the same kind.
 *
 * Kind matters: a mechanism memory and an answer memory for the same question are both useful and
 * must not evict each other. Bounded, because this is a working aid and not an archive.
 */
export async function rememberQuestion(
  entry: Omit<QuestionMemory, "fingerprint" | "at" | "hits"> & { at?: string; hits?: number },
): Promise<void> {
  const existing = await readQuestionMemory();
  const fingerprint = fingerprintOf(entry.sampleLabel);
  const isAnswer = entry.answer !== undefined;
  const key = memoryKey(entry.sampleLabel, entry.ats, entry.shape);
  const prior = existing.find(
    (m) => memoryKey(m.sampleLabel, m.ats, m.shape) === key && (m.answer !== undefined) === isAnswer,
  );
  const next = existing.filter((m) => m !== prior);
  next.push({
    ...entry,
    fingerprint,
    at: entry.at ?? new Date().toISOString(),
    hits: entry.hits ?? (prior?.hits ?? 0) + 1,
  });
  await fs.mkdir(path.dirname(MEMORY_PATH), { recursive: true }).catch(() => undefined);
  const tmp = `${MEMORY_PATH}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next.slice(-800), null, 2)}\n`, "utf8");
  await fs.rename(tmp, MEMORY_PATH);
}

/**
 * How hard to work on a field that is refusing.
 *
 * "especially common field" — his words. A question blocking twenty-nine applications deserves a
 * vision call and several experiments; one seen once deserves a cheap look. Counting is what makes
 * the budget honest: `blocking` comes from the ledger's own record of what stopped each run.
 */
export interface StudyBudget {
  /** Ask a vision model, not just a text one. */
  vision: boolean;
  /** How many distinct mechanisms may be tried on the live control. */
  experiments: number;
  /** Total wall-clock for the whole study, milliseconds. */
  ms: number;
}

export function studyBudgetFor(blocking: number): StudyBudget {
  if (blocking >= 10) return { vision: true, experiments: 6, ms: 90_000 };
  if (blocking >= 3) return { vision: true, experiments: 4, ms: 60_000 };
  return { vision: false, experiments: 2, ms: 25_000 };
}
