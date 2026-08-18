import fs from "node:fs/promises";
import { SKILL_PLAN_PATH } from "../config.js";

/**
 * What to select in a Workday "Type to Add Skills" prompt.
 *
 * The taxonomy names things its own way — "Python" is really eight entries ("Python
 * (Programming Language)", "Python Numpy", "Pandas Python Library", …) — and no amount of
 * cleverness on our side can guess which of them the candidate means. So the mapping is
 * curated by hand in skill.txt:
 *
 *   Python:
 *   Python (Programming Language)
 *   Python Numpy
 *   ...
 *
 * The heading is what gets TYPED (the search Workday runs server-side); the lines under it are
 * the exact option labels to tick from the result list.
 */

export interface SkillGroup {
  /** Typed into the search box, then Enter. */
  search: string;
  /** Exact option labels to select from the results. */
  select: string[];
}

export async function loadSkillPlan(): Promise<SkillGroup[]> {
  let raw: string;
  try {
    raw = await fs.readFile(SKILL_PLAN_PATH, "utf8");
  } catch {
    return [];
  }
  const groups: SkillGroup[] = [];
  let current: SkillGroup | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    // A heading ends in ":" — everything after it, until the next heading, is a selection.
    if (text.endsWith(":")) {
      current = { search: text.slice(0, -1).trim(), select: [] };
      if (current.search) groups.push(current);
      continue;
    }
    if (current) current.select.push(text);
  }
  return groups.filter((g) => g.select.length);
}
