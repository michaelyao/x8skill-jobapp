/**
 * Field-level verification from x8ocr layout blocks.
 *
 * The page-level check this replaces asked "does each recorded value appear ANYWHERE on the page?".
 * That catches a false success well, but it can produce a false PASS: if "Bachelor of Science"
 * happens to appear in the job description, an empty Degree field satisfies it. Containment is not
 * verification.
 *
 * With `includeLayout: true` x8ocr returns typed blocks with pixel-exact boxes, so a label can be
 * paired with ITS OWN value box and the comparison becomes per-field. Measured on a real form:
 *
 *   "Start date (Optional)" [ 89,722, 295,751]  ->  "MM/YYYY" [108,780, 213,811]
 *   "End date (Optional)"   [549,722, 743,751]  ->  "MM/YYYY" [568,780, 673,811]
 *
 * Same column, directly below. The x-overlap requirement is what stops "End date" pairing with
 * "Start date"'s value — both values sit at the same y.
 *
 * WHAT THIS ENGINE CANNOT DO, from its own capability notes rather than assumption:
 *   - `score` is layout-DETECTION confidence and does NOT separate correct text from garbled text.
 *     Do not threshold on it. (An earlier plan of mine did exactly that.)
 *   - No placeholder-vs-value distinction, so an empty box is still recognised by its text
 *     ("MM/YYYY", "Select…"), not by colour.
 *   - It STRIPS a leading required marker, so required-ness cannot be read from here.
 *   - No z-order: a floating overlay is merged into the region beneath it, which is why a date
 *     picker turned a Title field into a table.
 *
 * Pure functions over the block list: npm run test:blocks.
 */

export interface ScreenBlock {
  label: string;
  text: string;
  /** [x0, y0, x1, y1] in page pixels. Absent on some blocks. */
  box?: [number, number, number, number];
  order?: number;
  checked?: boolean;
}

/** Only trust geometry when the engine says its boxes are real. */
export interface ScreenCapability {
  boxes?: string;
  textFidelity?: string;
  deterministic?: boolean;
}

export const boxesAreExact = (cap?: ScreenCapability): boolean => cap?.boxes === "exact";
/** A vision engine may tidy or drop text, so "absent" is not evidence of "not filled". */
export const textIsLiteral = (cap?: ScreenCapability): boolean => cap?.textFidelity === "literal";

const fold = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * A label as the form prints it vs as we recorded it. OCR strips the required marker and the form
 * may add "(Optional)", so both are removed before comparing.
 */
const labelKey = (text: string): string =>
  fold(
    text
      .replace(/\(optional\)/gi, "")
      .replace(/[*✱﹡＊]/g, "")
      .replace(/^\s*\d+\.\s*/, ""),
  );

/** Text that means the box is EMPTY: a placeholder, not a value. */
const PLACEHOLDER = /^(mm\s*\/\s*yyyy|dd\s*\/\s*mm\s*\/\s*yyyy|yyyy|select|select\.\.\.|select an option|choose|choose file|start typing|none|n\/a|--?)$/i;

export const looksEmpty = (text: string): boolean => !text.trim() || PLACEHOLDER.test(text.trim());

const overlapsX = (a: [number, number, number, number], b: [number, number, number, number]): boolean => {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  // A value box is indented relative to its label, so require real overlap rather than containment.
  return width > Math.min(24, (a[2] - a[0]) * 0.3);
};

/**
 * The block holding the value for `wanted`, or undefined when the label is not on the page.
 * Returns the label block itself for a checkbox, whose state is on the block.
 */
export function valueBlockFor(
  blocks: ScreenBlock[],
  wanted: string,
): { label: ScreenBlock; value?: ScreenBlock } | undefined {
  const key = labelKey(wanted);
  if (!key) return undefined;
  const positioned = blocks.filter((b) => b.box);

  // The label block: an exact key match, else one that starts with the key (forms truncate).
  const label =
    positioned.find((b) => labelKey(b.text) === key) ??
    positioned.find((b) => labelKey(b.text).startsWith(key) && key.length >= 6);
  if (!label?.box) return undefined;

  // A checkbox carries its own state and its own text — there is nothing below to pair with.
  if (label.label === "checkbox") return { label };

  const lb = label.box;
  const below = positioned
    .filter((b) => b !== label && b.box && b.box[1] >= lb[3] - 6 && overlapsX(lb, b.box))
    .sort((a, b) => (a.box![1] ?? 0) - (b.box![1] ?? 0));

  const first = below[0];
  if (!first) return { label };
  // If the nearest thing below is ANOTHER label we recognise, this field has no value box at all.
  return { label, value: first };
}

export interface FieldVerdict {
  label: string;
  recorded: string;
  /** What the screen shows in that field's box. */
  onScreen: string;
  status: "match" | "empty" | "different" | "label-not-found";
}

/**
 * Compare each recorded answer against ITS OWN box on the screen.
 *
 * Long values are matched on a prefix: a narrow input visually truncates its text, which is what
 * made the page-level version report a correctly-filled field as missing.
 */
export function verifyFields(
  blocks: ScreenBlock[],
  answers: Array<{ label: string; value: string }>,
): FieldVerdict[] {
  const out: FieldVerdict[] = [];
  for (const { label, value } of answers) {
    const recorded = (value ?? "").trim();
    if (!recorded) continue;
    const found = valueBlockFor(blocks, label ?? "");
    if (!found) {
      out.push({ label, recorded, onScreen: "", status: "label-not-found" });
      continue;
    }
    if (found.label.label === "checkbox") {
      const wantChecked = /^(yes|true|checked|i agree|agree|on)$/i.test(recorded);
      const isChecked = found.label.checked === true;
      out.push({
        label,
        recorded,
        onScreen: isChecked ? "checked" : "unchecked",
        status: wantChecked === isChecked ? "match" : "different",
      });
      continue;
    }
    const shown = (found.value?.text ?? "").trim();
    if (looksEmpty(shown)) {
      out.push({ label, recorded, onScreen: shown, status: "empty" });
      continue;
    }
    const a = fold(recorded);
    const b = fold(shown);
    const probe = a.length > 24 ? a.slice(0, 24) : a;
    out.push({ label, recorded, onScreen: shown, status: b.includes(probe) ? "match" : "different" });
  }
  return out;
}

/**
 * The verdicts worth blocking a submit for, as sentences.
 *
 * `label-not-found` is NOT reported. A label the OCR did not place is far more likely to be our
 * reader's problem, a section scrolled out of the capture, or an overlay merge than a real empty
 * field — and blocking on it would fire on almost every long form. Only a field we located and
 * found empty or contradicted counts.
 */
export function describeVerdicts(verdicts: FieldVerdict[]): string[] {
  const out: string[] = [];
  for (const v of verdicts) {
    if (v.status === "empty") {
      out.push(`"${v.label}" was recorded as ${JSON.stringify(v.recorded)} but its box on the screen is empty${v.onScreen ? ` (shows ${JSON.stringify(v.onScreen)})` : ""}`);
    } else if (v.status === "different") {
      out.push(`"${v.label}" was recorded as ${JSON.stringify(v.recorded)} but the screen shows ${JSON.stringify(v.onScreen)}`);
    }
  }
  return out;
}
