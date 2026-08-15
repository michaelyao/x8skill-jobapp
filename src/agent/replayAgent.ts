import type { Agent, AgentContext, FieldAnswer, FieldSpec, FilledAnswer, PageSnapshot } from "./types.js";

// A collision-safe key for matching a stored answer to a field. Unlike
// normalizeQuestion (which strips parentheticals and so merges "(gender identity)"
// with "(race/ethnicity)"), this keeps every distinguishing character — only case
// and whitespace are normalized. Both stored and read labels come from the same
// reader, so they line up exactly.
const labelKey = (label: string): string => label.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The same label with its required marker removed. A field can gain or lose its asterisk
 * between the fill and the submit — measured on a live Ashby form, "…on a 4 point scale."
 * became "…on a 4 point scale.*" — and an exact match then fails, so a required field the
 * user HAD answered blocks the whole submission. Stripping only the marker cannot merge two
 * different questions, so this stays safe.
 */
const markerlessKey = (label: string): string =>
  labelKey(label).replace(/[*✱٭]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Deterministic agent: fills each field with the EXACT value the user already approved. It
 * never calls an LLM, so a submission reproduces what was reviewed.
 *
 * LABELS ARE NOT UNIQUE. A Workday experience page repeats "Company*", "Job Title*",
 * "From — Month" once per employment block. Keying a single answer per label meant one stored
 * value was written into EVERY block: an application came back with the same employer in
 * every row, and dates crossed between rows so the form rejected it with "Must end after
 * start date". Answers are therefore held as an ordered LIST per label and consumed
 * positionally — the n-th field with a label gets the n-th answer captured for it.
 *
 * When the page shows more occurrences than were approved, the extras get NOTHING rather than
 * a copy of another row's value. The required-field gate then refuses to advance, which is
 * the right outcome: stopping beats submitting an invented work history.
 */
export class ReplayAgent implements Agent {
  private readonly byLabel = new Map<string, FilledAnswer[]>();
  private readonly byMarkerless = new Map<string, FilledAnswer[]>();

  /** Required fields the form now shows that no approved answer covers. */
  readonly unmatchedRequired: string[] = [];
  /** Labels where the page had more occurrences than were approved (e.g. extra blocks). */
  readonly surplusOccurrences: string[] = [];

  constructor(answers: FilledAnswer[]) {
    for (const answer of answers) {
      const exact = labelKey(answer.label);
      this.byLabel.set(exact, [...(this.byLabel.get(exact) ?? []), answer]);
      const loose = markerlessKey(answer.label);
      this.byMarkerless.set(loose, [...(this.byMarkerless.get(loose) ?? []), answer]);
    }
  }

  async decide(snapshot: PageSnapshot, _ctx: AgentContext): Promise<FieldAnswer[]> {
    // Fields arrive in DOM order, so the n-th occurrence of a label on the page lines up with
    // the n-th answer captured for it during the fill. Counters are per-decide, i.e. per page.
    const seen = new Map<string, number>();

    return snapshot.fields.map((field: FieldSpec) => {
      const exact = labelKey(field.label);
      const index = seen.get(exact) ?? 0;
      seen.set(exact, index + 1);

      // The markerless list is a fallback only when the exact label is absent entirely — a
      // marker difference should not let one question's answer land in another's field.
      const list = this.byLabel.get(exact) ?? this.byMarkerless.get(markerlessKey(field.label));
      const stored = list?.[index];

      if (!stored || !stored.value) {
        if (list && index >= list.length) this.surplusOccurrences.push(field.label);
        if (field.required) this.unmatchedRequired.push(field.label);
        // Leave it empty. Anything the ATS autofilled validly stays; if it is required and
        // empty the gate stops the run, rather than submitting a hole — or a value copied
        // from a different row.
        return { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" as const };
      }

      return {
        key: field.key,
        value: stored.value,
        confidence: 1,
        source: "curated" as const,
        draft: stored.draft,
      };
    });
  }
}
