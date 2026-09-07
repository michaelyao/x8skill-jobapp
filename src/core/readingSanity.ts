import type { FieldSpec } from "../agent/types.js";

/**
 * DOES THIS READING OF THE PAGE EVEN HOLD TOGETHER?
 *
 * The candidate's point, and it is the sharpest thing said about this system:
 *
 *   "The filler might not be able to pickup the correct DOM, thus why it got empty option. and the
 *    LLM should be smart enough to think that it is NOT USUAL that: How do you hear from us with
 *    dropdown but not option found. The correct question at this moment should: is there something
 *    wrong with the filler?"
 *
 *   "I do not think LLM should fully trust what filler told it!"
 *
 * He is right, and the existing design has the opposite stance baked in. `read()` produces a
 * FieldSpec and every layer downstream treats it as ground truth. So when option capture failed on
 * Mastercard, the agent received `{ label: "How Did You Hear About Us?*", options: [] }` and
 * answered the question anyway — from the label alone, because that was all it had. It picked a row
 * that was really a folder, the click drilled in, and the run reported a stuck control.
 *
 * A dropdown with no options is not a page state. No employer ships a required choice with nothing
 * to choose. It is TESTIMONY THAT DOES NOT HOLD TOGETHER, and the correct response is to doubt the
 * reader rather than to answer the question.
 *
 * So this module reads the reading. Every rule below is deterministic, cheap, needs no model and no
 * browser, and each one has a real precedent in this repo's history — a rule with no precedent is a
 * rule inventing false alarms.
 *
 * WHAT IT DOES NOT DO: judge answers. Whether "Handshake" is the right thing to say is the top
 * layer's business. This only asks whether the thing we are being told about the page is credible.
 */

export type DoubtSeverity =
  /** The reading contradicts itself. Do not answer from it; re-read, then report a reader fault. */
  | "reader-fault"
  /** The reading is odd but possible. Worth a second look and a log line, not a refusal. */
  | "suspicious";

export interface ReadingDoubt {
  /** The field's label, or "(the page)" for a whole-page doubt. */
  field: string;
  /** What is wrong, in the words a person would use. */
  doubt: string;
  /** What a credible reading of this control would look like instead. */
  expected: string;
  severity: DoubtSeverity;
}

/** Controls whose whole purpose is to offer a choice. A choice with nothing to choose is a fault. */
const CHOICE_TYPES = new Set(["single_select", "multi_select", "radio"]);

const isChoice = (f: FieldSpec): boolean =>
  CHOICE_TYPES.has(f.type) || f.widget === "react-select" || f.widget === "workday-select";

/**
 * Bare sub-field names, meaningless on their own. A Workday experience page shows 44 fields
 * labelled "Month" at once, and an agent answering one of those is answering nothing.
 */
const BARE_LABEL = /^(month|day|year|from|to|state|city|country|zip|postal code|first|last|street)$/i;

/**
 * Fields whose real option list is long, so a handful of rows means a virtualised list we only saw
 * the top of — the country dialling code is ~250 entries shown fourteen at a time.
 */
const LONG_LIST = /country|dial|phone code|state|province|university|school|field of study|major|discipline|degree/i;

/** Whitespace-insensitive, case-insensitive comparison — labels and options are hand-typed. */
const same = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Doubts about ONE field.
 *
 * `searchable` is respected throughout: a type-to-search box's options are documented as an async
 * SAMPLE and not an allowlist, so an empty or short list there is expected rather than wrong. That
 * exemption is what keeps this from firing on every Workday taxonomy prompt.
 */
export function doubtsAboutField(field: FieldSpec): ReadingDoubt[] {
  const found: ReadingDoubt[] = [];
  const label = (field.label ?? "").trim();
  const options = field.options ?? [];

  if (field.required && !label) {
    found.push({
      field: "(unnamed)",
      doubt: "a required field with no label at all",
      expected: "every required control has a question attached to it",
      severity: "reader-fault",
    });
  }

  if (isChoice(field) && !field.searchable) {
    if (options.length === 0) {
      found.push({
        field: label || "(unnamed)",
        doubt: "a dropdown with no options",
        expected: "a choice control offers something to choose",
        severity: "reader-fault",
      });
    } else if (options.length === 1) {
      // A radio group read as one field, or a group whose siblings were missed.
      found.push({
        field: label,
        doubt: `only one option (${JSON.stringify(options[0]?.slice(0, 30))})`,
        expected: "a choice between at least two things",
        severity: "suspicious",
      });
    }
  }

  // The label/option split failed: the CC-305 shape, where each checkbox's own text became the
  // question and the real question ("Please check one of the boxes below") was never attached.
  const labelIsAnOption = label && options.some((o) => same(o, label));
  if (labelIsAnOption) {
    found.push({
      field: label,
      doubt: "the field's label is also one of its own options",
      expected: "the question and the answers are different text",
      severity: "reader-fault",
    });
  }

  if (BARE_LABEL.test(label) && !field.groupLabel && !field.section) {
    found.push({
      field: label,
      doubt: "a bare sub-field name with no question around it",
      expected: `"${label}" belongs to something — a date, an address, an employer`,
      severity: "suspicious",
    });
  }

  if (LONG_LIST.test(label) && !field.searchable && options.length > 1 && options.length < 15) {
    found.push({
      field: label,
      doubt: `${options.length} options for a list that is normally long`,
      expected: "the whole list, not the top of a virtualised one",
      severity: "suspicious",
    });
  }

  return found;
}

/**
 * Doubts about the PAGE, which no single field can see.
 *
 * The address case is the one already written down as unresolved in CLAUDE.md: GE Vernova and
 * Northrop both filled Address Line 1, City and Postal Code and never touched State, because State
 * was absent from the snapshot while plainly present and required on the screen. Motorola then
 * rejected an application for a postcode that did not match the state. A page that asks for a city
 * and a postcode and no state is not a form anyone ships.
 */
export function doubtsAboutPage(fields: readonly FieldSpec[]): ReadingDoubt[] {
  const found: ReadingDoubt[] = [];
  const has = (re: RegExp) => fields.some((f) => re.test(f.label ?? ""));

  if (has(/postal code|zip/i) && has(/^city|town/i) && !has(/state|province|region/i)) {
    found.push({
      field: "(the page)",
      doubt: "an address with a city and a postal code but no state",
      expected: "a US address form asks for the state too",
      severity: "suspicious",
    });
  }

  // A submit control with nothing to submit. Already handled elsewhere as a stop, but as a DOUBT
  // it says the right thing: we are probably not looking at the form we think we are.
  if (fields.length === 0) {
    found.push({
      field: "(the page)",
      doubt: "no fields at all were read",
      expected: "a form page has controls on it",
      severity: "suspicious",
    });
  }

  return found;
}

export function doubtsAboutReading(fields: readonly FieldSpec[]): ReadingDoubt[] {
  return [...fields.flatMap((f) => doubtsAboutField(f)), ...doubtsAboutPage(fields)];
}

/** The fields whose reading is self-contradictory, by label. Nothing should be answered from these. */
export function readerFaults(doubts: readonly ReadingDoubt[]): string[] {
  return [...new Set(doubts.filter((d) => d.severity === "reader-fault").map((d) => d.field))];
}

/** One line per doubt, for the log and for the dossier. */
export function describeDoubts(doubts: readonly ReadingDoubt[]): string[] {
  return doubts.map(
    (d) =>
      `${d.severity === "reader-fault" ? "the reader is wrong about" : "odd reading of"} ` +
      `"${d.field.slice(0, 46)}": ${d.doubt} — ${d.expected}`,
  );
}
