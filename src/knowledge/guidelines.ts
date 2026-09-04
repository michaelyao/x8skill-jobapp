/**
 * GUIDELINES — how to answer a KIND of question, edited by the candidate rather than by me.
 *
 * Q&A.txt answers one question exactly. Some questions cannot be enumerated that way because
 * every employer words them differently: "Are you applying to work on something specific at
 * Acme?", "Which areas interest you?", "What would you like to work on?". The preference behind
 * all of them is the same, and it belongs to the candidate.
 *
 * It used to live in two regexes in llmAgent — SOFTWARE_INTEREST and NOT_SOFTWARE_INTEREST — which
 * meant "prefer AI agents, avoid iOS work" was a code change only I could make. He asked for a
 * place to write it down. This is it, and guidelines.txt ships with his current rule in it.
 *
 * A guideline is PREFERENCE, never fact. Facts are the resume and Q&A.txt; nothing here may answer
 * a question about his degree, his GPA or his history.
 */
import fs from "node:fs/promises";
import { GUIDELINES_PATH } from "../config.js";

export interface Guideline {
  name: string;
  match: RegExp;
  prefer: string[];
  avoid: string[];
  note?: string;
}

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** Parse the file's text. Exported so the format is a test rather than a promise. */
export function parseGuidelines(text: string): Guideline[] {
  const out: Guideline[] = [];
  let current: Partial<Guideline> & { name?: string } = {};
  const flush = () => {
    if (current.name && current.match) {
      out.push({
        name: current.name,
        match: current.match,
        prefer: current.prefer ?? [],
        avoid: current.avoid ?? [],
        ...(current.note ? { note: current.note } : {}),
      });
    }
    current = {};
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      flush();
      current = { name: header[1].trim() };
      continue;
    }
    const kv = line.match(/^(MATCH|PREFER|AVOID|NOTE)\s*:\s*(.*)$/i);
    if (!kv || !current.name) continue;
    const key = kv[1].toUpperCase();
    const value = kv[2].trim();
    if (!value) continue;
    if (key === "MATCH") {
      // A bad regex must not take the run down with it — the file is hand-edited.
      try {
        current.match = new RegExp(value, "i");
      } catch {
        console.log(`  [guidelines] "${current.name}" has an unreadable MATCH and is ignored: ${value.slice(0, 60)}`);
        current = {};
      }
    } else if (key === "PREFER") current.prefer = splitList(value);
    else if (key === "AVOID") current.avoid = splitList(value);
    else current.note = value;
  }
  flush();
  return out;
}

let cached: Guideline[] | undefined;

export async function loadGuidelines(): Promise<Guideline[]> {
  if (cached) return cached;
  try {
    cached = parseGuidelines(await fs.readFile(GUIDELINES_PATH, "utf8"));
  } catch {
    cached = [];
  }
  return cached;
}

/** The guideline covering this question, if any. First match wins, so order the file by intent. */
export function guidelineFor(guidelines: readonly Guideline[], label: string): Guideline | undefined {
  return guidelines.find((g) => g.match.test(label ?? ""));
}

/**
 * Which of these options the guideline would choose.
 *
 * A term matches an option when either contains the other, case-insensitively — "AI agents"
 * against "AI Agents / Agentic Systems", "iOS" against "iOS Development". AVOID always wins over
 * PREFER, so "Mobile (iOS/Android) software development" is refused even though it says software.
 * Nothing matching returns nothing: a guideline that cannot see its own preference on the list
 * stays silent rather than picking the least-bad row.
 */
export function optionsUnderGuideline(g: Guideline, options: readonly string[]): string[] {
  const has = (option: string, terms: readonly string[]) => {
    const o = option.toLowerCase();
    return terms.some((t) => {
      const term = t.toLowerCase();
      return term.length > 1 && (o.includes(term) || term.includes(o));
    });
  };
  return options.filter((o) => o && has(o, g.prefer) && !has(o, g.avoid));
}

/** The instruction handed to the model for a free-text field. */
export function guidelineInstruction(g: Guideline): string {
  const bits = [
    g.prefer.length ? `prefer: ${g.prefer.join(", ")}` : "",
    g.avoid.length ? `never mention or ask for: ${g.avoid.join(", ")}` : "",
    g.note ?? "",
  ].filter(Boolean);
  return bits.join(". ");
}
