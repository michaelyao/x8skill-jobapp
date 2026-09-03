/**
 * A WORKDAY TAXONOMY CAN OFFER A CHOOSER INSTEAD OF THE LIST.
 *
 * Intel's "Education — Field of Study*" opens on two rows:
 *
 *   Partial List (First 500 Entries)
 *   All
 *
 * Neither is a field of study. The real entries are one level down, so every search reported "no
 * match for Computer and Information Science" and a REQUIRED field stayed empty — the same thing
 * RTX did, which is why this case has been written down in CLAUDE.md as "not yet handled" since
 * August. It blocked Intel twice this week.
 *
 * The test is that EVERY row is list-selection meta. One meta row among real answers is a real
 * list with an oddity in it ("All" is a legitimate answer to "which regions?"), and clicking
 * through that would throw away the options we came for.
 */
const META_ROW =
  /^(all|partial list|more|show (all|more)|first \d[\d,]* entries|see all|browse all|load more|more options?)\b/i;

const PARENTHETICAL = /\s*\([^)]*\)\s*$/;

/** Is this row list-navigation rather than an answer? */
export function isChooserRow(text: string): boolean {
  const t = text.replace(PARENTHETICAL, "").replace(/[.…]+$/, "").trim();
  if (!t) return false;
  return META_ROW.test(t);
}

/**
 * The row to click to reach the real options, or undefined when this is an ordinary list.
 *
 * Prefers the WIDEST view: "All" over "Partial List (First 500 Entries)", because the answer may
 * be outside the first 500 and a partial list that does not contain it looks identical to a
 * taxonomy that does not have it.
 */
export function listChooserRow(texts: readonly string[]): string | undefined {
  const rows = texts.map((t) => (t ?? "").trim()).filter((t) => t && !/^no items/i.test(t));
  if (rows.length < 2 || rows.length > 4) return undefined; // a chooser is a couple of rows, not a page
  if (!rows.every((t) => isChooserRow(t))) return undefined;
  const widest = rows.find((t) => /^all\b/i.test(t.replace(PARENTHETICAL, "").trim()));
  return widest ?? rows[0];
}
