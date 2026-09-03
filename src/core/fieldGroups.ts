/**
 * Is this group of options MUTUALLY EXCLUSIVE, whatever the input type says?
 *
 * Michelin's Self Identify page asks about disability as three options and the fill loop answered
 * all three — "Yes, I have a disability", "No, I do not have a disability", "I do not want to
 * answer". The candidate looked at the page and saw nothing wrong, which is the useful part: the
 * widget holds one, so the harm was wasted clicks and an arbitrary last-one-wins outcome rather
 * than a false statement. But an answer nobody chose is still not an answer.
 *
 * My first guard keyed on `type === "radio"` and could never fire: Workday's reader reports these
 * as CHECKBOX. The input type does not carry the meaning. The LABELS do — "Yes, I have…" against
 * "No, I do not have…" cannot both be true, and "I do not want to answer" excludes both.
 */
const AFFIRM = /^\s*yes\b/i;
const DENY = /^\s*no\b/i;
const DECLINE = /(do not want to answer|don.?t want to answer|prefer not to (say|answer)|decline to (self.?identify|answer)|choose not to)/i;

/**
 * True when the labels describe alternatives to ONE question rather than independent boxes.
 *
 * Deliberately conservative: it needs an explicit contradiction. "Select all that apply" groups —
 * the areas-of-interest question, the race/ethnicity list — carry no Yes/No pairing and no decline
 * option, so they keep taking multiple ticks, which is the whole point of them.
 */
export function isExclusiveGroup(labels: readonly string[]): boolean {
  if (labels.length < 2) return false;
  const affirms = labels.filter((l) => AFFIRM.test(l)).length;
  const denies = labels.filter((l) => DENY.test(l)).length;
  const declines = labels.filter((l) => DECLINE.test(l)).length;
  if (affirms >= 1 && denies >= 1) return true;
  // A decline option alongside anything else is an alternative to it, not an addition.
  return declines >= 1 && labels.length >= 2;
}
