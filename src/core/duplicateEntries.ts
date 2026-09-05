/**
 * DUPLICATE COMMITTED ENTRIES ON A WORKABLE PROFILE.
 *
 * Pony.ai's application went to review with Carnegie Mellon listed THREE times under Education and
 * Bay Area Rapid Transit twice under Experience - identical school, degree and period; identical
 * title, company, summary and period. An application claiming three degrees is not a formatting
 * nit, and the candidate found it by reading the page.
 *
 * The guards that stop us ADDING a duplicate exist (alreadyListed for experience, schoolListed for
 * education). Nothing removed the ones already committed - by the ATS's own resume parse, or by an
 * earlier run made before those guards existed.
 *
 * EXACT duplicates only, and the FIRST of each group is kept. Two genuinely different rows that
 * happen to share a company are both kept, because their text differs. This deletes from a live
 * form, so the rule has to be one that cannot be argued with.
 */
export interface CommittedEntry {
  /** Which list it is in - entries only ever duplicate within their own section. */
  section: string;
  /** Position in that section, as rendered. */
  index: number;
  /** The row's full visible text. */
  text: string;
}

const normalise = (t: string): string =>
  t
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

/**
 * Which entries to delete, highest index first so removing one cannot shift the position of
 * another still to be removed.
 */
export function duplicateEntriesToDelete(entries: readonly CommittedEntry[]): CommittedEntry[] {
  const seen = new Set<string>();
  const drop: CommittedEntry[] = [];
  for (const e of entries) {
    const body = normalise(e.text);
    if (!body) continue; // an empty row is not a duplicate of anything
    const key = `${e.section} ${body}`;
    if (seen.has(key)) drop.push(e);
    else seen.add(key);
  }
  return drop.sort((a, b) => b.index - a.index);
}
