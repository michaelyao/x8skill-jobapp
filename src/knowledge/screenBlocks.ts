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

/**
 * A block that VISIBLY CARRIES a radio or checkbox control renders one OPTION of a group, and this
 * engine reports no selection state — so the row says nothing about which option is chosen.
 * Unlocatable for exactly the reason a "Yes No" pair is: a verdict we cannot see is worse than no
 * verdict. "○ I identify as one or more of the classifications of protected veteran" was quoted as
 * the value of "Veteran Status" against a recorded "I am not a protected veteran"; the glyph is what
 * gives it away as a control. A TICK is deliberately absent from the set — a visibly checked box
 * does carry state, and the checkbox branch above is allowed to judge it.
 */
const UNSELECTED_GLYPH = /[○◯◦⃝☐□▢®©]/u;
const carriesAnUnsetControl = (text: string): boolean => UNSELECTED_GLYPH.test(text);

/**
 * A RADIO GROUP puts every option on the screen at once, so whichever row lands nearest the label is
 * not evidence of the answer. Comparing against it manufactured findings on four queued
 * applications — "US Citizen / Permanent Resident" reported against the "H-1B" row, "None" against
 * "Other". A row that MATCHES what we recorded is still a match, because that search runs first;
 * this only turns a pairing we cannot resolve into "unlocatable" rather than a fault.
 */
const rendersEveryOption = (type?: string): boolean =>
  /^(radio|radiogroup|checkbox-group|checkboxgroup)$/i.test((type ?? "").trim());

/**
 * A textarea scrolled to the caret shows a FRAGMENT of a long answer, and OCR mangles the character
 * it clips through — "zero-direct" for "zero-defect", "redesigned" for "I designed" — which broke
 * the exact-substring tolerance and reported two correct essays as wrong. So ask what fraction of
 * the fragment's words appear in the value we recorded: a clipped copy of our own text is almost
 * entirely contained, a different answer is not. Long values only, where a fragment is what we
 * expect to be looking at.
 */
const mostlyOurWords = (shown: string, recorded: string): boolean => {
  const mine = shown.split(" ").filter((w) => w.length >= 3);
  const theirs = shown && recorded ? recorded.split(" ").filter((w) => w.length >= 3) : [];
  if (mine.length < 8 || theirs.length < 20) return false;
  const have = new Set(theirs);
  return mine.filter((w) => have.has(w)).length / mine.length >= 0.7;
};

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
    .filter((b) => b.label !== "title" && !others.has(labelKey(b.text)))
    /**
     * Nor is a TABLE. The engine merges a region it reads as tabular into one block of HTML, and
     * pairing that with a label produced "LinkedIn Profile … but the screen shows
     * <table><tr><td>Yesse" — a finding about our own reader, dressed as a finding about the form.
     */
    .filter((b) => b.label !== "table" && !/^\s*<table/i.test(b.text ?? ""))
    /**
     * Nor is GARBAGE. "- α-Δ-ε" was reported as what the screen showed for an email that was in
     * fact filled correctly: a block with almost no letters is a rendering artefact, an icon or a
     * rule, and it can neither confirm nor contradict a value.
     */
    .filter((b) => {
      const t = (b.text ?? "").trim();
      if (t.length < 3) return false;
      const letters = (t.match(/[a-z0-9]/gi) ?? []).length;
      return letters / t.length >= 0.4;
    });

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
  answers: Array<{ label: string; value: string; type?: string }>,
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

  for (const { label, value, type } of answers) {
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
      .map((place) => ({ place, verdict: judgeOne(blocks, place, label, recorded, allLabels, type) }))
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

/**
 * A CHECKBOX GROUP's state, read from the GLYPHS IN ITS TEXT.
 *
 * x8ocr's own capability notes say it has "no notion of placeholder vs value, CHECKBOX STATE, or
 * z-order", and the block-level `checked` flag bears that out: it goes true when ANYTHING in a
 * merged region is ticked. Trusting it produced three findings on one Sierra application that said
 * boxes were ticked claiming Nathan is bisexual and has a disability, when the capture reads
 * "☐ Bisexual" and "☐ Person with disability" — the ticked box was elsewhere in the same region.
 * Answers we never gave, reported as if we had given them, is the worst output this check has.
 *
 * The text does carry the truth, literally: "☐ Yes\n☑ No". So the rows are parsed out of it and the
 * flag is not consulted at all.
 */
const TICKED = /[☑☒✓✔🗹]/u;
const EMPTY_BOX = /[☐□○◯▢⃝]/u;

export interface TickRow {
  /** The option's text, with its glyph removed. */
  row: string;
  ticked: boolean;
}

export function tickRows(regionText: string): TickRow[] {
  const out: TickRow[] = [];
  for (const line of String(regionText ?? "").split(/[\n\r]+/)) {
    const t = line.trim();
    if (!t) continue;
    const ticked = TICKED.test(t);
    if (!ticked && !EMPTY_BOX.test(t)) continue; // not an option row
    const row = t.replace(TICKED, " ").replace(EMPTY_BOX, " ").trim();
    out.push({ row, ticked });
  }
  return out;
}

/**
 * Which row a recorded answer is ABOUT, and whether that row is ticked.
 *
 * Two shapes reach this. A yes/no question records "Yes" and its rows ARE "Yes" and "No", so the
 * row is found by the value. A "select all that apply" group records "No" against a label that
 * names the option — "How do you identify your sexual orientation? … — Bisexual" — so the row is
 * found by the LABEL'S TAIL and the value says whether it should be ticked.
 *
 * Anything else is unreadable rather than wrong: a bare "☐" with no option text next to it (seen on
 * a required work-authorisation question) does not say which option it belongs to, and a recorded
 * graduation date paired with a checkbox region is a bad pairing, not a bad form.
 */
export function tickVerdictFor(
  regionText: string,
  label: string,
  recorded: string,
): "match" | "different" | "unreadable" {
  const rows = tickRows(regionText).filter((r) => r.row);
  if (!rows.length) return "unreadable";
  const same = (a: string, b: string) => {
    const x = labelKey(a);
    const y = labelKey(b);
    return Boolean(x && y && (x === y || x.startsWith(y) || y.startsWith(x)));
  };
  const wantsTicked = /^(yes|true|checked|i agree|agree|on|selected)$/i.test(recorded.trim());
  const isYesNo = /^(yes|no|true|false)$/i.test(recorded.trim());

  /**
   * The row this answer is about may be named by the label's TAIL ("… — Bisexual", one option of a
   * group) or by the WHOLE label ("I currently work here", a checkbox standing on its own). Tail
   * first: on a group the whole label also matches the region, and the tail is the specific option.
   */
  const tail = label.split(/\s+[—–-]\s+/).pop() ?? "";
  for (const named of [tail, label]) {
    if (!named) continue;
    const byOption = rows.find((r) => same(r.row, named));
    if (byOption) return byOption.ticked === wantsTicked ? "match" : "different";
  }
  if (isYesNo) {
    const byValue = rows.find((r) => same(r.row, recorded));
    if (byValue) return byValue.ticked ? "match" : "different";
  }
  const byValue = rows.find((r) => same(r.row, recorded));
  if (byValue) return byValue.ticked ? "match" : "different";
  return "unreadable";
}

function judgeOne(
  blocks: ScreenBlock[],
  place: ScreenBlock,
  label: string,
  recorded: string,
  allLabels: string[],
  type?: string,
): FieldVerdict {
  const found = locateFrom(blocks, place, label, allLabels);

  if (found.label.label === "checkbox") {
    /**
     * Read the GLYPHS, never the `checked` flag — the engine says it has no notion of checkbox
     * state, and the flag is true whenever anything in a merged region is ticked.
     */
    const verdict = tickVerdictFor(found.label.text ?? "", label, recorded);
    const rows = tickRows(found.label.text ?? "").filter((r) => r.row);
    const shown = rows.length
      ? rows.map((r) => `${r.ticked ? "☑" : "☐"} ${r.row}`).join("  ")
      : (found.label.text ?? "").trim();
    if (verdict === "unreadable") return { label, recorded, onScreen: shown, status: "value-not-located" };
    return { label, recorded, onScreen: shown, status: verdict };
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
    return b.includes(head) || (tail.length >= 12 && a.includes(tail)) || mostlyOurWords(b, a);
  };
  const hit = (found.candidates ?? [found.value]).find((c) => c && fits(c.text ?? ""));
  if (hit) return { label, recorded, onScreen: (hit.text ?? "").trim(), status: "match" };

  const shown = (found.value.text ?? "").trim();
  if (looksEmpty(shown)) return { label, recorded, onScreen: shown, status: "empty" };
  if (looksLikeProse(shown, recorded)) return { label, recorded, onScreen: shown, status: "value-not-located" };
  if (carriesAnUnsetControl(shown)) return { label, recorded, onScreen: shown, status: "value-not-located" };
  if (rendersEveryOption(type)) return { label, recorded, onScreen: shown, status: "value-not-located" };
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
    /**
     * SAME QUESTION? Compare word overlap, not edges.
     *
     * OCR damages a long question wherever the capture cuts it and misreads words inside it. One
     * label on Notion came back as "quires that you are willing to relocate to one of the following
     * locations IY, USA or San Francisco, CA, USA. Please confirm that you are willing to this
     * role?*" — clipped in front, "NY" read as "IY", and three words dropped from the middle. It had
     * been answered "Yes". Openings, closings and a fixed middle window each fail on that, because
     * each assumes the damage is somewhere else; two of three findings on that application were
     * this, and a check that reports answered questions as missing is one nobody reads.
     *
     * Words survive what edges do not. Most of a long question's words are still there and still in
     * the label we answered, so ask what fraction of them are — high for the same question worded
     * imperfectly, low for a different one.
     */
    const words = (t: string) => t.split(" ").filter((w) => w.length >= 3);
    const sameQuestion = (recorded: string): boolean => {
      if (recorded.includes(key) || key.includes(recorded)) return true;
      const mine = words(key);
      if (mine.length < 4) return false;
      const theirs = new Set(words(recorded));
      const shared = mine.filter((w) => theirs.has(w)).length;
      return shared / mine.length >= 0.7;
    };
    if ([...answered].some(sameQuestion)) continue;
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
