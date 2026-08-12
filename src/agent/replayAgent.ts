import type { Agent, AgentContext, FieldAnswer, FilledAnswer, PageSnapshot } from "./types.js";

// A collision-safe key for matching a stored answer to a field. Unlike
// normalizeQuestion (which strips parentheticals and so merges "(gender identity)"
// with "(race/ethnicity)"), this keeps every distinguishing character — only case
// and whitespace are normalized. Both stored and read labels come from the same
// reader, so they line up exactly.
const labelKey = (label: string): string => label.toLowerCase().replace(/\s+/g, " ").trim();

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

  constructor(answers: FilledAnswer[]) {
    this.byLabel = new Map(answers.map((a) => [labelKey(a.label), a]));
  }

  async decide(snapshot: PageSnapshot, _ctx: AgentContext): Promise<FieldAnswer[]> {
    return snapshot.fields.map((field) => {
      const stored = this.byLabel.get(labelKey(field.label));
      if (stored && stored.value) {
        return { key: field.key, value: stored.value, confidence: 1, source: "curated", draft: stored.draft };
      }
      // No approved value for this field. If it's already filled (e.g. ATS resume
      // autofill), leave it; the gate only blocks on empty required fields.
      return { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
    });
  }
}
