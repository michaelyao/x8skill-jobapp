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
  /** Approved answers whose question is no longer on the form. Not a blocker — nothing is
   *  submitted for a question that does not exist — but worth reporting. */
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

    drifts.push({ label: answer.label, now: answer.value, kind: "question not approved" });
  }

  const vanished = approved
    .filter((a) => a.value && !consumed.has(a))
    .map((a) => ({ label: a.label, value: a.value }));

  return { drifts, vanished, matched, rewordedButSame, safeToSubmit: drifts.length === 0 };
}

/** Human-readable lines for the console, the queue entry and the log. */
export function describeDrift(report: DriftReport): string[] {
  return report.drifts.map((d) =>
    d.kind === "value changed"
      ? `"${d.label}": you approved "${d.approved}", the form now has "${d.now}"`
      : `"${d.label}" was not on the form you approved, and would be answered "${d.now}"`,
  );
}
