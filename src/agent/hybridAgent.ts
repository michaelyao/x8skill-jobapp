import type { Agent, AgentContext, FieldAnswer, FieldSpec, FilledAnswer, PageSnapshot } from "./types.js";

const labelKey = (label: string): string => label.toLowerCase().replace(/\s+/g, " ").trim();
const markerlessKey = (label: string): string =>
  labelKey(label).replace(/[*✱٭]+/g, " ").replace(/\s+/g, " ").trim();

/** A field the approved set did not cover, so something else had to answer it. */
export interface NovelField {
  label: string;
  required: boolean;
  value: string;
  reason: "not in the approved answers" | "more occurrences than were approved";
}

/**
 * Re-fill on the submit path, preferring what the user approved.
 *
 * A pure replay assumes the page is the one that was approved — but approval can take days,
 * and by then the session is gone and the form may have moved on. A pure re-fill has the
 * opposite problem: it would submit values the user never saw. This does both jobs at once.
 *
 * For every field the page shows, an approved answer is used when one exists (matched exactly
 * as ReplayAgent does — by label, positionally, so repeated blocks like "Company*" get their
 * own value and not a copy of row one's). Everything else falls through to the LLM, and is
 * RECORDED in `novel`. The caller then decides whether the result is still what was approved;
 * this class deliberately does not make that judgement, it only reports what it had to invent.
 */
export class HybridAgent implements Agent {
  private readonly byLabel = new Map<string, FilledAnswer[]>();
  private readonly byMarkerless = new Map<string, FilledAnswer[]>();

  /** Fields whose value did NOT come from the approved set. The materiality gate reads this. */
  readonly novel: NovelField[] = [];

  constructor(
    approved: FilledAnswer[],
    private readonly fallback: Agent,
  ) {
    for (const answer of approved) {
      const exact = labelKey(answer.label);
      this.byLabel.set(exact, [...(this.byLabel.get(exact) ?? []), answer]);
      const loose = markerlessKey(answer.label);
      this.byMarkerless.set(loose, [...(this.byMarkerless.get(loose) ?? []), answer]);
    }
  }

  async decide(snapshot: PageSnapshot, ctx: AgentContext): Promise<FieldAnswer[]> {
    const seen = new Map<string, number>();
    const answers = new Map<string, FieldAnswer>();
    const gaps: FieldSpec[] = [];
    const gapReason = new Map<string, NovelField["reason"]>();

    for (const field of snapshot.fields) {
      const exact = labelKey(field.label);
      const index = seen.get(exact) ?? 0;
      seen.set(exact, index + 1);

      const list = this.byLabel.get(exact) ?? this.byMarkerless.get(markerlessKey(field.label));
      const stored = list?.[index];

      /**
       * AN APPROVED BLANK IS AN ANSWER.
       *
       * This tested `stored?.value`, so an approved empty string — falsy — read as "no approved
       * answer for this field" and went to the LLM as a gap. The candidate approved "" for
       * Pony.ai's "Summary (Optional)", meaning he does not want a summary on it; the replay then
       * wrote a nine-line summary, the drift check compared it against the approved "" and held
       * the application for re-approval, telling him the FORM had changed. Nothing had changed
       * except our own filling, and the one thing he had explicitly decided was the thing we
       * overrode.
       *
       * So the test is whether an approved answer EXISTS for this occurrence, not whether it has
       * text in it. `blank` marks it answered-and-empty, which is what stops the turn loop
       * reporting it as "no answer available".
       */
      if (stored) {
        answers.set(field.key, {
          key: field.key,
          value: stored.value ?? "",
          confidence: 1,
          source: "curated",
          draft: stored.draft,
          blank: !String(stored.value ?? "").trim(),
        });
        continue;
      }
      gaps.push(field);
      gapReason.set(
        field.key,
        list && index >= list.length ? "more occurrences than were approved" : "not in the approved answers",
      );
    }

    // Ask the LLM only about the gaps, and only when there are any — a submit visit of a
    // completely unchanged form must cost nothing and involve no model at all.
    if (gaps.length) {
      const filled = await this.fallback.decide({ ...snapshot, fields: gaps }, ctx);
      for (const answer of filled) {
        answers.set(answer.key, answer);
        const field = gaps.find((f) => f.key === answer.key);
        if (field && answer.value) {
          this.novel.push({
            label: field.label,
            required: field.required,
            value: answer.value,
            reason: gapReason.get(field.key) ?? "not in the approved answers",
          });
        }
      }
    }

    return snapshot.fields.map(
      (f) => answers.get(f.key) ?? { key: f.key, value: "", confidence: 0, needsHuman: true, source: "curated" as const },
    );
  }
}
