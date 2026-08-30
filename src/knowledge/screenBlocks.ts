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

const words = (text: string): number => fold(text).split(" ").filter(Boolean).length;

/**
 * A sentence of guidance under a question is not that question's answer.
 *
 * "Can you work on-site in San Francisco during the week?" is followed by "Our office is about a
 * 10 minute walk from the Ferry Building", and the Yes/No control below it was never detected —
 * so the nearest block to the label is prose, and reporting it as the field's value turns a
 * finished application into "recorded Yes but the screen shows Our office is about…".
 */
const looksLikeProse = (candidate: string, recorded: string): boolean =>
  words(candidate) >= 6 && words(recorded) <= 3;

const overlapsX = (a: [number, number, number, number], b: [number, number, number, number]): boolean => {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  // A value box is indented relative to its label, so require real overlap rather than containment.
  return width > Math.min(24, (a[2] - a[0]) * 0.3);
};

/**
 * A block whose text runs well past the label we asked for is a merged REGION — a whole section OCR
 * ran together, as Workday's option lists do. Its box spans several fields, so nothing below it can
 * be attributed to this one.
 */
const carriesMoreThanTheLabel = (block: ScreenBlock, key: string): boolean =>
  labelKey(block.text).length > key.length + 4;
const isMergedRegion = (block: ScreenBlock, key: string): boolean =>
  labelKey(block.text).length > key.length + 60;

export interface LocatedField {
  label: ScreenBlock;
  /** The nearest candidate — kept for callers that only want one. */
  value?: ScreenBlock;
  /** Every block within reach, nearest first. A question can be followed by helper text. */
  candidates?: ScreenBlock[];
  /** The label block swallowed several fields; its geometry cannot locate a value box. */
  merged?: boolean;
}

/**
 * Every block that could be this label, best first.
 *
 * A label is not unique on a real page. An Ashby posting prints "Location" as a heading over the
 * JOB's location in the left column, and the application form has its own "Location *" field on
 * the right — so pairing the first match reported "Location was recorded as Pittsburgh, PA but the
 * screen shows New York City", the job's city, about a field that was filled correctly.
 */
export function labelBlocksFor(blocks: ScreenBlock[], wanted: string): ScreenBlock[] {
  const key = labelKey(wanted);
  if (!key) return [];
  const positioned = blocks.filter((b) => b.box);
  const exact = positioned.filter((b) => labelKey(b.text) === key);
  const prefixed =
    key.length >= 6
      ? positioned.filter((b) => labelKey(b.text).startsWith(key) && labelKey(b.text) !== key)
      : [];
  return [...exact, ...prefixed];
}

/**
 * The block holding the value for `wanted`, or undefined when the label is not on the page.
 * Returns the label block itself for a checkbox, whose state is on the block.
 *
 * `otherLabels` are the labels of the OTHER answers on the same screen. Without them the search
 * pairs a label with whatever text sits below it, and on a real form that is usually the NEXT
 * FIELD'S LABEL: "Name" was reported as showing "Current location", which is the label of the field
 * after it. The comment above this function has always said a recognised label is not a value; this
 * is that check, finally written.
 */
/**
 * The block holding the value for `wanted`, or undefined when the label is not on the page.
 * Returns the label block itself for a checkbox, whose state is on the block.
 *
 * `otherLabels` are the labels of the OTHER answers on the same screen. Without them the search
 * pairs a label with whatever text sits below it, and on a real form that is usually the NEXT
 * FIELD'S LABEL: "Name" was reported as showing "Current location", which is the label of the field
 * after it.
 */
export function valueBlockFor(
  blocks: ScreenBlock[],
  wanted: string,
  otherLabels: string[] = [],
): LocatedField | undefined {
  const label = labelBlocksFor(blocks, wanted)[0];
  if (!label?.box) return undefined;
  return locateFrom(blocks, label, wanted, otherLabels);
}

/** The pairing, from ONE specific label block. */
function locateFrom(
  blocks: ScreenBlock[],
  label: ScreenBlock,
  wanted: string,
  otherLabels: string[],
): LocatedField {
  const key = labelKey(wanted);
  const positioned = blocks.filter((b) => b.box);

  // A checkbox carries its own state and its own text — there is nothing below to pair with.
  if (label.label === "checkbox") return { label };
  if (isMergedRegion(label, key)) return { label, merged: true };

  const lb = label.box!;
  const others = new Set(otherLabels.map(labelKey).filter((k) => k && k !== key));
  /**
   * A value sits DIRECTLY under its label. Three hundred pixels down is the next section, not this
   * field's value — measured on a live Ashby form, where "Name" reached past its own (undetected)
   * input to pair with a label 299px below. Real pairs on the same captures sit 15–35px apart.
   */
  const reach = Math.max(60, (lb[3] - lb[1]) * 3);
  const candidates = positioned
    .filter(
      (b) =>
        b !== label &&
        b.box &&
        b.box[1] >= lb[3] - 6 &&
        b.box[1] - lb[3] <= reach &&
        overlapsX(lb, b.box),
    )
    .sort((a, b) => (a.box![1] ?? 0) - (b.box![1] ?? 0))
    // A section heading is never a value, and neither is another field's label.
    .filter((b) => b.label !== "title" && !others.has(labelKey(b.text)));

  return { label, value: candidates[0], candidates };
}

export interface FieldVerdict {
  label: string;
  recorded: string;
  /** What the screen shows in that field's box. */
  onScreen: string;
  status: "match" | "empty" | "different" | "label-not-found" | "value-not-located";
}

/**
 * Compare each recorded answer against ITS OWN box on the screen.
 *
 * Truncation is tolerated at BOTH ends. A narrow input clips its text, so a long value is matched on
 * its opening; a textarea scrolled to the caret shows only its TAIL, and OCR mangles the character
 * it clips through ("‘acking" for "…tracking"), so the ragged first token is dropped before the
 * second comparison. Demanding the whole string reported correctly-filled fields as wrong.
 */
export function verifyFields(
  blocks: ScreenBlock[],
  answers: Array<{ label: string; value: string }>,
): FieldVerdict[] {
  const out: FieldVerdict[] = [];
  const allLabels = answers.map((a) => a.label ?? "");
  /**
   * Where the FORM is. A posting page shows the job's details in one column and the application in
   * another; most recorded labels belong to the form, so the median of the labels that appear
   * exactly once locates it. Labels that appear twice are the ambiguous ones and are left out.
   */
  const unambiguous = allLabels
    .map((l) => labelBlocksFor(blocks, l))
    .filter((found) => found.length === 1)
    .map((found) => found[0].box?.[0] ?? 0)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const column = unambiguous.length ? unambiguous[Math.floor(unambiguous.length / 2)] : 0;

  for (const { label, value } of answers) {
    const recorded = (value ?? "").trim();
    if (!recorded) continue;
    const places = labelBlocksFor(blocks, label ?? "");
    if (!places.length) {
      out.push({ label, recorded, onScreen: "", status: "label-not-found" });
      continue;
    }
    /**
     * Judge EVERY place the label appears and keep the kindest reading. When the same words label
     * two different things — the job's location in the posting and the applicant's location on the
     * form — a problem is only real if every plausible pairing agrees there is one.
     *
     * And when they DO agree, the one to report is the form's. Measured on the LSWING capture: the
     * applicant's Location field holds "United States" while the entry recorded "Pittsburgh, PA",
     * which is a real difference — but the posting's heading is higher up the page, so the finding
     * was described as "the screen shows New York City", the job's city. True, useless, and it
     * reads like a bug in the checker. The form's fields cluster in one column, so the label block
     * nearest that cluster is the one to quote.
     */
    const readings = places
      .map((place) => ({ place, verdict: judgeOne(blocks, place, label, recorded, allLabels) }))
      .sort((a, b) => {
        const rank = (v: FieldVerdict) => (v.status === "match" ? 0 : v.status === "value-not-located" ? 1 : 2);
        const byStatus = rank(a.verdict) - rank(b.verdict);
        if (byStatus) return byStatus;
        return Math.abs((a.place.box?.[0] ?? 0) - column) - Math.abs((b.place.box?.[0] ?? 0) - column);
      });
    out.push(readings[0].verdict);
  }
  return out;
}

function judgeOne(
  blocks: ScreenBlock[],
  place: ScreenBlock,
  label: string,
  recorded: string,
  allLabels: string[],
): FieldVerdict {
  const found = locateFrom(blocks, place, label, allLabels);

  if (found.label.label === "checkbox") {
    const wantChecked = /^(yes|true|checked|i agree|agree|on)$/i.test(recorded);
    const isChecked = found.label.checked === true;
    return {
      label,
      recorded,
      onScreen: isChecked ? "checked" : "unchecked",
      status: wantChecked === isChecked ? "match" : "different",
    };
  }

  const a = fold(recorded);
  const head = a.length > 24 ? a.slice(0, 24) : a;
  /**
   * The label block sometimes CONTAINS the answer: OCR merges a question and the option under it
   * into one region. That is the field's own block, not "somewhere on the page", so it is
   * evidence — and it is checked only when the block carries text beyond the label itself, so a
   * bare "Start date (Optional)" can never vouch for an empty date.
   */
  if (carriesMoreThanTheLabel(found.label, labelKey(label ?? "")) && fold(found.label.text).includes(head)) {
    return { label, recorded, onScreen: found.label.text.trim(), status: "match" };
  }
  /**
   * No box we can attribute to this field. That is NOT "the field is empty": a filled value OCR
   * did not detect looks identical from here, and blocking a finished application on our own
   * reader's miss is the failure this check exists to avoid. Only a box we FOUND, showing a
   * placeholder, counts as empty.
   */
  if (found.merged || !found.value) return { label, recorded, onScreen: "", status: "value-not-located" };

  /**
   * A YES/NO PAIR TELLS US NOTHING about which one is chosen, and must be settled BEFORE the
   * containment search — "Yes No" contains "Yes", so the pair was reading as a MATCH and quietly
   * vouching for a field that might have had "No" selected. A false pass is worse than a false
   * alarm: it is the check saying it verified something it cannot see.
   *
   * The widget renders both words and marks the choice by colour, which this engine does not
   * report. Unlocatable, like every other pairing we cannot resolve. (x8ocr R8, text colour, is
   * what would turn this into a real answer.)
   */
  const nearest = (found.value.text ?? "").trim();
  if (/^\W*(yes\W+no|no\W+yes)\W*$/i.test(nearest) && /^(yes|no)$/i.test(recorded)) {
    return { label, recorded, onScreen: nearest, status: "value-not-located" };
  }

  /**
   * ANY block within reach may hold the value. A question is often followed by helper text and
   * then the control, so insisting on the nearest block reports the guidance as the answer.
   */
  const fits = (text: string): boolean => {
    const b = fold(text);
    if (!b) return false;
    const tail = b.split(" ").slice(1).join(" ");
    return b.includes(head) || (tail.length >= 12 && a.includes(tail));
  };
  const hit = (found.candidates ?? [found.value]).find((c) => c && fits(c.text ?? ""));
  if (hit) return { label, recorded, onScreen: (hit.text ?? "").trim(), status: "match" };

  const shown = (found.value.text ?? "").trim();
  if (looksEmpty(shown)) return { label, recorded, onScreen: shown, status: "empty" };
  if (looksLikeProse(shown, recorded)) return { label, recorded, onScreen: shown, status: "value-not-located" };
  return { label, recorded, onScreen: shown, status: "different" };
}


/**
 * Questions the FORM asks that we have no answer for.
 *
 * verifyFields iterates OUR answers and asks whether each is on the screen. That can only ever
 * confirm what we already believe: a question the reader never saw has no answer, so it was never
 * examined. It catches drift and is structurally blind to OMISSION — which is how five REQUIRED
 * questions on one Ashby form ("Do you currently reside in Houston, TX?", visa sponsorship, three
 * about experience) reached the review page with nothing filled and nothing reported. The candidate
 * found them by opening the form himself.
 *
 * So this reads the other way round: start from what is PRINTED and report a required question with
 * no recorded answer. It needs no view of the widget's state — not knowing whether a Yes/No pair is
 * pressed does not matter when we have no answer to that question at all.
 *
 * Only REQUIRED questions: an optional field left blank is not a fault, and a gap reported on every
 * optional one would bury the real ones.
 */
export function unansweredOnScreen(
  blocks: ScreenBlock[],
  answers: Array<{ label: string; value: string }>,
): string[] {
  const answered = new Set(
    answers.filter((a) => (a.value ?? "").trim()).map((a) => labelKey(a.label ?? "")).filter(Boolean),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const raw = (block.text ?? "").replace(/\s+/g, " ").trim();
    // A required marker is the whole signal: the form is saying it will not go without this.
    if (!/[*\u2731\uFE61\uFF0A]\s*$/.test(raw)) continue;
    // A heading is not a question, and a merged region is several fields at once — neither can be
    // attributed to one missing answer.
    if (block.label === "title") continue;
    const key = labelKey(raw);
    if (!key || key.length < 8 || seen.has(key)) continue;
    seen.add(key);
    if (answered.has(key)) continue;
    /**
     * Match on a PREFIX as well as containment. OCR clips a long question at the end and mangles
     * the character it clips through — "…require sponsorship for employment visa stat H" for a
     * label that continues "…visa status (e.g., H-1B visa status)?" — so neither string contains
     * the other and a question we DID answer gets reported as missing. Every long question on a
     * form would raise a false gap, and a check that cries wolf on long questions is one nobody
     * will act on.
     */
    /**
     * Truncation happens at BOTH ends. OCR clips a long question where the box cuts it — the end
     * for a wrapped line, the START when the capture begins mid-label: measured, "hat pronouns
     * would you like our team to use…" for "What pronouns…", and "cate all of the locations…" for
     * "Please indicate all of the locations…". Matching only the opening reports those as
     * unanswered questions we had in fact answered, and three of five findings on one application
     * were exactly that.
     */
    const opening = (t: string) => t.slice(0, 40);
    const closing = (t: string) => t.slice(-40);
    if (
      [...answered].some(
        (a) =>
          (a.length >= 8 && (a.includes(key) || key.includes(a))) ||
          (Math.min(a.length, key.length) >= 24 &&
            (opening(a) === opening(key) || closing(a) === closing(key))),
      )
    ) {
      continue;
    }
    out.push(`the form marks "${raw.slice(0, 90)}" REQUIRED and nothing was recorded for it`);
  }
  return out;
}

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
