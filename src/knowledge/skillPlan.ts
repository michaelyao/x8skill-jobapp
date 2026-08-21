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

/** One selection: the exact label to tick, and the term that finds it. */
export interface SkillPick {
  search: string;
  label: string;
}

/**
 * A heading whose entries are DELETED from the form instead of added to it.
 *
 * Uploading the resume makes the ATS populate Skills from its own parse of the PDF, and it
 * guesses badly. Those entries are not in the plan above, so nothing we do adds them — the
 * only way they leave the form is by being removed after the autofill. Keeping the list in
 * this same file is deliberate: the skills policy is one curated thing, and a second file
 * would drift out of step with it.
 */
const REMOVE_HEADING = /^(remove|remove skills?|do not add|blocklist)$/i;

/** Parse every section, add and remove alike. */
async function parseSections(): Promise<SkillGroup[]> {
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
    // A "#" line is a note to the reader, not a taxonomy entry. Without this every comment
    // became a skill label to tick under whichever heading preceded it, and the search for it
    // reported the whole plan as stale.
    if (text.startsWith("#")) continue;
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

export async function loadSkillPlan(): Promise<SkillGroup[]> {
  // The REMOVE section is not a search term. Left in, "REMOVE" would be typed into the
  // taxonomy box and its six entries ticked ON — the exact opposite of the intent.
  return (await parseSections()).filter((g) => !REMOVE_HEADING.test(g.search));
}

/**
 * Skill labels to take OFF the form, exactly as the taxonomy spells them.
 *
 * Returned verbatim because the match against the form is exact: a substring rule would
 * remove "Language Processing" along with "Natural Language", and "Formal Verification"
 * along with "Verification".
 */
export async function loadSkillRemovals(): Promise<string[]> {
  const out: string[] = [];
  for (const group of await parseSections()) {
    if (!REMOVE_HEADING.test(group.search)) continue;
    // A "| term" override is meaningless for a removal (nothing is searched for), so keep
    // only the label and tolerate the syntax rather than treating it as part of the name.
    for (const line of group.select) out.push(line.split("|")[0].trim());
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Flatten the plan into individual picks, honouring a per-line search override.
 *
 * The heading is normally both the group name and the search term, but the taxonomy does not
 * always agree: "Node.js" is not among the results for "JavaScript" — it is found by typing
 * "Node". A line may therefore name its own term after a pipe:
 *
 *   JavaScript:
 *   JavaScript
 *   Node.js | Node
 */
export async function loadSkillPicks(): Promise<SkillPick[]> {
  const picks: SkillPick[] = [];
  for (const group of await loadSkillPlan()) {
    for (const line of group.select) {
      const [label, override] = line.split("|");
      picks.push({ label: label.trim(), search: (override ?? group.search).trim() });
    }
  }
  return picks.filter((p) => p.label && p.search);
}

/** One committed value ("pill") as read off a form, with the container that holds it. */
export interface SkillPill {
  /** Marker attribute value, used to click this exact pill back in the page. */
  mark: string;
  /** The `data-automation-id` of the container. */
  containerId: string;
  /** The question the container asks, as rendered. */
  containerLabel: string;
  /** The pill's own text, whitespace-collapsed. */
  text: string;
}

/**
 * Does this container ask about skills?
 *
 * Deciding here rather than in the page script keeps the rule testable — and it is a rule
 * worth testing, because it is the only thing standing between a removal and deleting a pill
 * out of some other multi-select. The container's LABEL is used, never its full text: the
 * text includes the pills, so a pill named "...Skills..." would make any container match.
 */
export function isSkillContainer(containerId: string, containerLabel: string): boolean {
  return /skill/i.test(containerId) || /\bskills?\b/i.test(containerLabel);
}

/**
 * Which removal, if any, this pill's text names — matched EXACTLY, case- and
 * whitespace-insensitive only.
 *
 * Exact is the whole point. On the list the ATS autofilled, "Natural Language" must go while
 * "Language Processing" stays, and "Verification" must not take "Formal Verification" with
 * it; a substring or fuzzy rule silently deletes a skill the candidate actually has.
 *
 * A pill's text can pick up its delete control's own label, so a trailing "Delete"/"Remove"
 * is tolerated. Nothing else is: an unrecognised pill is left alone.
 */
export function matchingRemoval(text: string, removals: string[]): string | undefined {
  const collapse = (v: string): string => v.replace(/\s+/g, " ").trim().toLowerCase();
  const raw = collapse(text);
  const stripped = collapse(text.replace(/\s*(delete|remove|close|clear|×|✕|✖)\s*$/i, ""));
  for (const removal of removals) {
    const want = collapse(removal);
    if (!want) continue;
    if (raw === want || stripped === want) return removal;
  }
  return undefined;
}

/** The pills to delete: a skills container, and an exact removal match. */
export function pillsToRemove(pills: SkillPill[], removals: string[]): Array<{ mark: string; label: string }> {
  const out: Array<{ mark: string; label: string }> = [];
  for (const pill of pills) {
    if (!isSkillContainer(pill.containerId, pill.containerLabel)) continue;
    const label = matchingRemoval(pill.text, removals);
    if (label) out.push({ mark: pill.mark, label });
  }
  return out;
}
