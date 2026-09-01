/**
 * Is this posting the SUMMER INTERNSHIP we are applying for, or something else wearing similar
 * words?
 *
 * The list is built from sections named "Summer 2027", but a title inside one can still be a co-op,
 * a new-grad programme, or an internship in the wrong term — and those are decisions the candidate
 * may answer differently: a co-op usually means a semester away from classes, and a new-grad role
 * cannot be taken at all while still enrolled. Neither is a fault in the application, so this
 * REPORTS rather than blocks.
 *
 * Pure: npm run test:roleterm.
 */
export type RoleTerm = "summer-internship" | "co-op" | "new-grad" | "off-cycle-internship" | "unclear";

export interface RoleVerdict {
  term: RoleTerm;
  /** Why, in the posting's own words, so the reminder can quote it. */
  because: string;
  /**
   * Worth a second look before submitting. TRUE only for a posting that is positively something
   * else: a co-op, a new-grad role, or an internship in a named term that is not summer.
   *
   * Deliberately FALSE for "unclear". Most intern titles name no season — "Backend Software Engineer
   * Intern" — and they come from a list built out of Summer 2027 sections, so they are summer
   * internships with a terse title. Flagging them raised a warning on fourteen of forty-one queued
   * applications, and a flag on a third of the queue is one nobody reads. The classification is
   * still reported; it just does not shout.
   */
  needsAThought: boolean;
}

const SUMMER = /\bsummer\b/i;
const INTERN = /\bintern(ship|s)?\b/i;
const COOP = /\bco-?ops?\b/i;
const NEW_GRAD = /\bnew ?grad(uate)?s?\b|\bgraduate (programme|program|scheme)\b|\bentry[- ]level\b|\bcampus hire\b/i;
const OFF_CYCLE = /\b(fall|autumn|spring|winter)\b/i;

/** A term the posting names, e.g. "Summer 2027" or "Fall 2026". */
const season = (text: string): string | undefined =>
  text.match(/\b(summer|fall|autumn|spring|winter)\s*(20\d\d)?\b/i)?.[0]?.trim();

export function classifyRoleTerm(title: string, description = ""): RoleVerdict {
  const t = (title ?? "").trim();
  // The TITLE decides. A description mentions every programme an employer runs — "we also hire
  // co-ops" on a summer internship posting would misclassify it — so the body is only consulted
  // when the title says nothing either way.
  const strong = t;
  const weak = `${t} ${(description ?? "").slice(0, 600)}`;

  if (COOP.test(strong)) return { term: "co-op", because: `the title says "${season(strong) ?? "co-op"}"`, needsAThought: true };
  if (NEW_GRAD.test(strong)) {
    return { term: "new-grad", because: `the title reads as a new-graduate role`, needsAThought: true };
  }
  if (!INTERN.test(strong)) {
    // No mention of an internship anywhere is the clearest signal of a full-time posting.
    if (!INTERN.test(weak)) return { term: "new-grad", because: "nothing in the posting calls it an internship", needsAThought: true };
    return { term: "unclear", because: "the title does not say whether it is an internship", needsAThought: false };
  }
  if (SUMMER.test(strong)) return { term: "summer-internship", because: `the title says "${season(strong) ?? "Summer"}"`, needsAThought: false };
  if (OFF_CYCLE.test(strong)) {
    return { term: "off-cycle-internship", because: `the title says "${season(strong)}", not Summer`, needsAThought: true };
  }
  // An internship with no term named: usually summer, but not stated — worth a glance, not an alarm.
  if (SUMMER.test(weak)) return { term: "summer-internship", because: "the posting mentions summer", needsAThought: false };
  if (COOP.test(weak)) return { term: "co-op", because: "the posting describes a co-op", needsAThought: true };
  return { term: "unclear", because: "no term is named in the title or the opening of the description", needsAThought: false };
}
