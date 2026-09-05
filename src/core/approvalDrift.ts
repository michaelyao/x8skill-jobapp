import type { FilledAnswer } from "../agent/types.js";

/**
 * Does what is about to be submitted still match what the user approved?
 *
 * The submit path re-fills the form rather than replaying blind, because approval can take
 * days and the session that filled it is long gone. Re-filling means the page can produce
 * something the user never saw — so before the submit control is touched, every value on the
 * form is checked against the approved set.
 *
 * The rule is deliberately narrow: **a value may be submitted only if the user approved that
 * value.** Not "an equivalent value", not "a value for a similar question" — the same string.
 * A question may be REWORDED and still pass, but only when the answer going into it is
 * character-for-character the one that was approved for the question it replaced. Everything
 * else stops the submit and asks for a fresh approval, which costs a click; submitting
 * something the user never read costs an application.
 *
 * A DISAPPEARED question blocks too. It is tempting to wave it through — no question, nothing
 * submitted — but that reasoning has the causation backwards. Employers rarely reword a live
 * posting; our reader changes constantly. So the probable cause of a question vanishing is
 * that WE stopped seeing it, in which case the form still has it and we are about to submit
 * with an approved answer missing. Measured on this queue: nearly every difference so far was
 * our own reader changing, not the posting. Treat a difference as a suspected bug in this
 * code, not as news about the employer.
 */

const labelKey = (label: string): string => label.toLowerCase().replace(/\s+/g, " ").trim();
const markerless = (label: string): string =>
  labelKey(label).replace(/[*✱٭]+/g, " ").replace(/\s+/g, " ").trim();

/** Values are compared leniently on FORMATTING only — case and spacing, nothing semantic. */
const valueKey = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
  return i;
}

export interface Drift {
  label: string;
  now: string;
  approved?: string;
  kind: "value changed" | "question not approved";
}

export interface DriftReport {
  drifts: Drift[];
  /** Approved answers whose question we no longer see. A BLOCKER: most likely we stopped
   *  reading a field that is still there, so submitting would drop an answer the user gave. */
  vanished: Array<{ label: string; value: string }>;
  matched: number;
  /** Questions that were reworded but carry the identical approved value. */
  rewordedButSame: Array<{ approvedLabel: string; nowLabel: string; value: string }>;
  safeToSubmit: boolean;
}

export function compareToApproved(approved: FilledAnswer[], current: FilledAnswer[]): DriftReport {
  const byLabel = new Map<string, FilledAnswer[]>();
  const byMarkerless = new Map<string, FilledAnswer[]>();
  for (const a of approved) {
    byLabel.set(labelKey(a.label), [...(byLabel.get(labelKey(a.label)) ?? []), a]);
    byMarkerless.set(markerless(a.label), [...(byMarkerless.get(markerless(a.label)) ?? []), a]);
  }

  const seen = new Map<string, number>();
  const consumed = new Set<FilledAnswer>();
  const drifts: Drift[] = [];
  const rewordedButSame: DriftReport["rewordedButSame"] = [];
  let matched = 0;

  for (const answer of current) {
    if (!answer.value) continue; // nothing goes into the form, so nothing to approve

    const exact = labelKey(answer.label);
    const index = seen.get(exact) ?? 0;
    seen.set(exact, index + 1);

    const list = byLabel.get(exact) ?? byMarkerless.get(markerless(answer.label));
    const stored = list?.[index];

    if (stored) {
      consumed.add(stored);
      if (valueKey(stored.value) === valueKey(answer.value)) matched += 1;
      else drifts.push({ label: answer.label, now: answer.value, approved: stored.value, kind: "value changed" });
      continue;
    }

    // No question by that name. It may be the same question, reworded — which is only
    // acceptable if the value now going in is exactly the one that was approved for the
    // question it appears to replace. The VALUE is the thing the user approved; the label
    // similarity is just what lets us pair them up.
    const twin = approved.find(
      (a) =>
        !consumed.has(a) &&
        valueKey(a.value) === valueKey(answer.value) &&
        commonPrefix(labelKey(a.label), exact) >= 25,
    );
    if (twin) {
      consumed.add(twin);
      matched += 1;
      rewordedButSame.push({ approvedLabel: twin.label, nowLabel: answer.label, value: answer.value });
      continue;
    }

    /**
     * A RELABELLED QUESTION IS NOT A CHANGED ANSWER.
     *
     * The pairing above needs a 25-character common prefix, and OUR OWN label derivation changed
     * under a pending approval: "Education — School" became "* School", "Education — Field of
     * Study" became "Field of study (Optional)". Same question, same value, no prefix in common —
     * so one answer was reported TWICE, once as a question that was not approved and once as an
     * answer that had vanished. Pony.ai came back with seventeen "differences" of which zero were
     * a different value, after the candidate had approved it repeatedly and checked the screenshot
     * himself.
     *
     * The comment above is right: the VALUE is the thing he approved, and the label is our
     * bookkeeping. So when the value is IDENTICAL and unambiguous — it appears exactly once among
     * the answers still unaccounted for on each side — pair them regardless of what the label now
     * says. Nothing new goes into the form; the same string goes into the same box.
     *
     * Unambiguous is the whole safety of it. A repeated "Yes" cannot be paired this way, because
     * moving a Yes from one question to another WOULD change what is submitted, so those still
     * have to match by label and still block.
     */
    const remaining = approved.filter((a) => !consumed.has(a) && a.value);
    const sameValue = remaining.filter((a) => valueKey(a.value) === valueKey(answer.value));
    const alsoHereNow = current.filter(
      (c) => c !== answer && c.value && valueKey(c.value) === valueKey(answer.value),
    );
    if (sameValue.length === 1 && alsoHereNow.length === 0 && valueKey(answer.value).length >= 4) {
      consumed.add(sameValue[0]);
      matched += 1;
      rewordedButSame.push({ approvedLabel: sameValue[0].label, nowLabel: answer.label, value: answer.value });
      continue;
    }

    drifts.push({ label: answer.label, now: answer.value, kind: "question not approved" });
  }

  const vanished = approved
    .filter((a) => a.value && !consumed.has(a))
    .map((a) => ({ label: a.label, value: a.value }));

  return { drifts, vanished, matched, rewordedButSame, safeToSubmit: drifts.length === 0 && vanished.length === 0 };
}

/** Human-readable lines for the website, the queue entry and the log. */
export function describeDrift(report: DriftReport): string[] {
  const lines = report.drifts.map((d) =>
    d.kind === "value changed"
      ? `"${d.label}": you approved "${d.approved}", the form now has "${d.now}"`
      : `"${d.label}" was not on the form you approved, and would be answered "${d.now}"`,
  );
  for (const v of report.vanished) {
    lines.push(
      `"${v.label}" is not being answered now — you approved "${v.value}". The field probably still exists and we stopped reading it, so submitting would leave it blank.`,
    );
  }
  return lines;
}
