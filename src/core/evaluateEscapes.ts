/**
 * BROKEN REGEX ESCAPES INSIDE page.evaluate() STRINGS.
 *
 * `page.evaluate()` takes a STRING here (see CLAUDE.md — it must be an invoked IIFE), and that
 * string is written as a template literal. A template literal is not a place where `\s` means
 * whitespace: JS has no `\s` escape, so it collapses to the bare letter. `/\s+/g` written inside
 * an evaluate template reaches the page as `/s+/g` and replaces every letter "s" with a space.
 *
 * That is not a hypothetical. `read()` builds a sub-field's label from its automation id and then
 * normalised the whitespace with a single-escaped `\s`, so for the last several months every date
 * field on every Workday form was recorded as:
 *
 *     "startDate"        -> " tartDate"        -> "tart Date — From* — Work Experience — Month"
 *     "firstYearAttended" -> "fir tYearAttended" -> "fir t Year Attended — From — Education — Year"
 *
 * while "endDate" and "dateSignedOn" — which contain no lowercase "s" — came through perfect, so
 * the damage looked like a handful of odd labels rather than one broken regex. 652 recorded fields
 * carry a mangled label. A label is how an answer is matched to its question in the store, to its
 * approved value on re-fill, and to its block in the visual check, so a silently corrupted label
 * is not cosmetic.
 *
 * The tokens matter differently: `\b` becomes a BACKSPACE character (a valid string escape), `\d`
 * `\w` `\s` become plain letters, and any of them turns a correct-looking regex into a wrong one
 * with no error anywhere. The fix is always to double the backslash.
 *
 * This is a lint, not a unit test, because the bug is invisible at the call site and the next
 * evaluate string someone writes will look exactly as plausible as these did.
 */
export interface BrokenEscape {
  line: number;
  token: string;
  text: string;
}

const ESCAPE = /(?<!\\)\\([sdwbSDWB])/g;

/** Every `evaluate(\`…\`)` / `$eval(\`…\`)` template literal in a source file, with its offset. */
function evaluateTemplates(source: string): Array<{ start: number; body: string }> {
  const out: Array<{ start: number; body: string }> = [];
  /**
   * Two shapes to catch. A template passed straight to `.evaluate(\`…\`)`, and — the ones that
   * matter most — a template ASSIGNED TO A CONST and passed by name (`const READ_SCRIPT = \`(() => {`,
   * then `root.evaluate(READ_SCRIPT)`). The biggest page scripts in this repo are all the second
   * shape, so a scanner that only knew the first found three harmless normalisations and missed the
   * one that had been mangling every date label on every Workday form.
   *
   * The second shape is recognised by the IIFE opening that CLAUDE.md requires of page scripts:
   * a template whose first non-space characters are `(() =>` or `(function`.
   */
  const opener = /(?:\.(?:evaluate|evaluateAll|evaluateHandle|\$\$eval|\$eval)\s*\(\s*(?:[A-Za-z0-9_.$]+\s*,\s*)?`)|(?:`(?=\s*\((?:\(\s*\)|function)))/g;
  for (let m = opener.exec(source); m; m = opener.exec(source)) {
    const start = m.index + m[0].length;
    // Walk to the matching backtick, honouring escapes and skipping `${…}` interpolations, whose
    // contents are ordinary code where `\s` is fine.
    let i = start;
    let body = "";
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        // A DOUBLED backslash is the correct spelling — it reaches the page as one, so `\\s` is a
        // real `\s`. Blank it out. A LONE backslash is the bug, so keep both characters for the
        // scan below. (Getting this backwards is easy: the first version of this walk skipped
        // every escape and therefore reported that nothing was wrong.)
        if (source[i + 1] === "\\") { body += "  "; i += 2; continue; }
        body += ch + (source[i + 1] ?? " ");
        i += 2;
        continue;
      }
      if (ch === "`") break;
      if (ch === "$" && source[i + 1] === "{") {
        let depth = 1;
        i += 2;
        while (i < source.length && depth > 0) {
          if (source[i] === "{") depth += 1;
          else if (source[i] === "}") depth -= 1;
          body += source[i] === "\n" ? "\n" : " ";
          i += 1;
        }
        continue;
      }
      body += ch;
      i += 1;
    }
    out.push({ start, body });
    opener.lastIndex = i;
  }
  return out;
}

/** Single-escaped regex tokens inside this file's evaluate strings. */
export function findBrokenEscapes(source: string): BrokenEscape[] {
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  const found: BrokenEscape[] = [];
  for (const tpl of evaluateTemplates(source)) {
    for (const m of tpl.body.matchAll(ESCAPE)) {
      const at = tpl.start + (m.index ?? 0);
      const lines = tpl.body.slice(0, m.index ?? 0).split("\n");
      const line = lineOf(tpl.start) + lines.length - 1;
      const text = (source.split("\n")[line - 1] ?? "").trim();
      found.push({ line, token: m[0], text: text.slice(0, 100) });
      void at;
    }
  }
  return found;
}
