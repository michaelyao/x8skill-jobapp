/**
 * WHY A CONTROL WOULD NOT TAKE A VALUE, AND WHAT TO TRY - asked at the moment of failure, from
 * facts read off the live page.
 *
 * The candidate's instruction: "you should NOT let the process fail easily without re-study on
 * spot, and at the moment fail, you have all the context, you should learn on spot and try very
 * very hard to solve it." A diagnosis that does not act is still a failure.
 *
 * So this returns a REMEDY as well as a reason - but only ever one of a fixed set of actions the
 * driver already knows how to perform and verify. The model chooses among them; it does not
 * invent one. A fix invented by a model and executed unseen on a live application is precisely
 * the failure mode the rest of this codebase spends its guards preventing, and "try harder" is not
 * a reason to drop that.
 */
import { callModel, type ModelImage } from "./modelCall.js";

/** The only actions a study may ask for. Each is implemented and verified by the driver. */
export const REMEDIES = [
  "click-label",
  "click-parent",
  "dismiss-overlay",
  "scroll-into-view",
  "type-instead-of-click",
  "force-click",
  "none",
] as const;
export type Remedy = (typeof REMEDIES)[number];

export interface FieldDiagnosis {
  why: string;
  remedy: Remedy;
}

/**
 * IT CAN SEE THE CONTROL NOW, and for this question that matters more than the DOM.
 *
 * Whether a row in a dropdown ANSWERS or OPENS is a visual fact — a chevron on its right-hand edge
 * — and tenants express it in markup a hundred different ways or not at all. Measured on the real
 * capture of Mastercard's "How Did You Hear About Us?" prompt: described as three strings the model
 * says it cannot tell and picks one, which is how a folder got chosen as an answer. Shown the
 * picture it says "all three rows are folders, each has a '>' chevron on the right".
 *
 * `images` is optional and a call with none is byte-for-byte the text call this used to be, so a
 * study on a page we could not photograph still works.
 */
export async function explainStuckField(
  label: string,
  facts: string,
  images: readonly ModelImage[] = [],
): Promise<FieldDiagnosis> {
  const system = [
    "You diagnose why a form control would not accept a value, and choose ONE remedy to try.",
    "You are given facts read from the live element. Do not invent any others.",
    ...(images.length
      ? [
          "You are also shown a picture of the control. Trust the picture over the facts where they disagree:",
          "the facts come from our own reader, which is what failed.",
          "Look for: a chevron or arrow on a row (it OPENS a sub-list rather than answering — remedy none,",
          "and say so in `why`, because the caller must not treat it as a control that refuses);",
          "something drawn over the control; whether the real clickable is the box or a label beside it.",
        ]
      : []),
    `The remedy MUST be exactly one of: ${REMEDIES.join(", ")}.`,
    "Guidance: if something else is topmost at the control's centre, the control is covered - use dismiss-overlay.",
    "If the input is hidden or zero-sized but has a label, the visible control is the label - use click-label.",
    "If it is off-screen use scroll-into-view. If it is a text box that ignored a programmatic fill use type-instead-of-click.",
    "If the facts do not support any of these, use none.",
    'Reply with ONLY {"why":"<one sentence, under 25 words>","remedy":"<one of the list>"}.',
  ].join("\n");
  const user = `Field label: ${label}\nFacts read from the page:\n${facts}`;

  const raw = await callModel(system, user, images).catch(() => "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { why: "the model did not answer", remedy: "none" };
  try {
    const parsed = JSON.parse(match[0]) as { why?: string; remedy?: string };
    const remedy = (REMEDIES as readonly string[]).includes(parsed.remedy ?? "")
      ? (parsed.remedy as Remedy)
      : "none";
    return { why: (parsed.why ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given", remedy };
  } catch {
    return { why: "the model's answer did not parse", remedy: "none" };
  }
}
