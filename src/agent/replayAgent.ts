import type { Agent, AgentContext, FieldAnswer, FilledAnswer, PageSnapshot } from "./types.js";

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
  labelKey(label).replace(/[*✱\u066D]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Deterministic agent: fills each field with the EXACT value the user already
 * approved (captured during the fill run), matched by normalized label. It never
 * calls an LLM, so a submission reproduces precisely what was reviewed.
 *
 * A field with no stored answer that is REQUIRED and still empty is returned as
 * needsHuman → the turn loop's required-field gate then refuses to advance, so we
 * never submit a form with a hole the user didn't sign off on.
 */
export class ReplayAgent implements Agent {
  private readonly byLabel: Map<string, FilledAnswer>;
  private readonly byMarkerless: Map<string, FilledAnswer>;
  /** Required fields the form now shows that no approved answer matches — i.e. the form
   *  changed since the user reviewed it. Reported so the failure says so, instead of the
   *  uninformative "did not reach review". */
  readonly unmatchedRequired: string[] = [];

  constructor(answers: FilledAnswer[]) {
    this.byLabel = new Map(answers.map((a) => [labelKey(a.label), a]));
    // Ambiguity check: if two stored questions collapse to the same markerless key, the
    // loose match could pick the wrong one, so that key is not offered at all.
    const counts = new Map<string, number>();
    for (const a of answers) counts.set(markerlessKey(a.label), (counts.get(markerlessKey(a.label)) ?? 0) + 1);
    this.byMarkerless = new Map(
      answers.filter((a) => counts.get(markerlessKey(a.label)) === 1).map((a) => [markerlessKey(a.label), a]),
    );
  }

  async decide(snapshot: PageSnapshot, _ctx: AgentContext): Promise<FieldAnswer[]> {
    return snapshot.fields.map((field) => {
      const stored = this.byLabel.get(labelKey(field.label)) ?? this.byMarkerless.get(markerlessKey(field.label));
      if (!stored && field.required) this.unmatchedRequired.push(field.label);
      if (stored && stored.value) {
        return { key: field.key, value: stored.value, confidence: 1, source: "curated", draft: stored.draft };
      }
      // No approved value for this field. If it's already filled (e.g. ATS resume
      // autofill), leave it; the gate only blocks on empty required fields.
      return { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
    });
  }
}
