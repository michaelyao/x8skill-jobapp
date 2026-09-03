/**
 * A Workday date is three TWO-DIGIT spinbuttons, and a single digit never commits.
 *
 * Michelin's My Experience page asks Start Date and End Date as `— Month` / `— Year` sub-fields.
 * The answers on record were "1" and "4"; the form showed 12/2025 — 12 being what the resume
 * autofill had put there — and the required-field gate stopped the run with "2 field(s) the form
 * marks REQUIRED have no answer". The Signed On date on the same page, answered "09" / "03" /
 * "2026", committed perfectly.
 *
 * That is the whole difference: the spinbutton wants MM, it treats one digit as a part-typed entry,
 * and it discards it on blur. So the value never landed, the PREFILL stayed, and a wrong date sat
 * on a finished application looking like an answer we had chosen.
 *
 * Month names are handled for the same reason: a model asked for "Month" will sometimes answer
 * "January", which a numeric spinbutton takes even less well than "1".
 */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Is this label a date PART — the Month/Day/Year sub-field of a split date widget? */
export function datePartOf(label: string): "month" | "day" | "year" | undefined {
  const l = label.toLowerCase().trim();
  // The part is the tail of a qualified label ("Start Date — From* — Work Experience — Month")
  // or the whole of a bare one. Anchoring on the tail keeps "Month of graduation" out of it,
  // which is a free-text question rather than a spinbutton.
  const m = l.match(/(?:^|—\s*)(month|day|year)\s*\*?\s*$/);
  return (m?.[1] as "month" | "day" | "year" | undefined) ?? undefined;
}

/**
 * The value to type into a date part: two digits for a month or a day, four for a year.
 * Returns the value unchanged when it is not a date part or cannot be read as one — this
 * normalises, it does not invent.
 */
export function datePartValue(label: string, value: string): string {
  const part = datePartOf(label);
  if (!part) return value;
  const v = value.trim();
  if (part === "year") {
    // A two-digit year is ambiguous and a spinbutton wants four, so only expand what is certain.
    const m = v.match(/(\d{4})/);
    return m ? m[1] : v;
  }
  if (part === "month") {
    const named = MONTHS.findIndex((n) => n.startsWith(v.toLowerCase().slice(0, 3)) && v.length >= 3);
    if (named >= 0) return String(named + 1).padStart(2, "0");
  }
  const digits = v.match(/^\D*(\d{1,2})\D*$/);
  if (!digits) return v;
  const n = Number(digits[1]);
  if (part === "month" && (n < 1 || n > 12)) return v;
  if (part === "day" && (n < 1 || n > 31)) return v;
  return String(n).padStart(2, "0");
}
