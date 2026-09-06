/**
 * IS THE FORM BEHIND A CAPTCHA?
 *
 * "Never try to defeat explicit CAPTCHAs" is already the rule, and SmartRecruiters is already
 * detected and left alone for exactly this reason. What was missing is the case where a form we DO
 * drive puts one in front of us mid-application, because then the failure arrives dressed as a
 * fill bug.
 *
 * ACDS MWSNDJ, on Lever, came back six times as "blocked on: Current location ✱". The field is a
 * plain 489x40 text input, enabled, writable, not covered — study mode said so. What is actually
 * happening: TWO hCaptcha iframes, 1440x1000 each, sit over the whole viewport; document.
 * activeElement is the iframe; typing "Sun" into the location field lands and is wiped 300ms later.
 * Every keystroke was going to the challenge, not the form.
 *
 * Reported honestly, that is not a field that will not take a value — it is an application that
 * needs a person. Reported as a stuck field, it is a re-fill loop that can never end, which is
 * what the candidate was looking at.
 *
 * DETECTION IS DELIBERATELY NARROW. A reCAPTCHA badge sits on a great many perfectly fillable
 * forms, and an invisible challenge is 1x1 in the corner; neither blocks anything. The question is
 * not "is there a captcha on this page" but "is one standing between us and the form": it must
 * cover a real area AND be what the browser finds at the middle of a control we are trying to
 * fill, or hold the focus itself.
 */

/** The script is a STRING and an invoked IIFE — see the invariant in CLAUDE.md. */
export const CAPTCHA_PROBE = `(() => {
  const RE = /hcaptcha|recaptcha|turnstile|datadome|arkoselabs|funcaptcha/i;
  const isChallenge = (el) => {
    if (!el) return false;
    for (let up = el, i = 0; up && i < 4; up = up.parentElement, i += 1) {
      if (up.tagName === "IFRAME") {
        const who = (up.getAttribute("src") || "") + " " + (up.getAttribute("title") || "");
        if (RE.test(who)) return true;
      }
    }
    return false;
  };

  // Holding the focus is decisive on its own: keystrokes are going to it, not to the form.
  const active = document.activeElement;
  if (active && active.tagName === "IFRAME") {
    const who = (active.getAttribute("src") || "") + " " + (active.getAttribute("title") || "");
    if (RE.test(who)) return "the challenge has taken the keyboard focus";
  }

  // Otherwise: does one sit ON a control we would be filling?
  const controls = Array.from(document.querySelectorAll("input, textarea, select")).filter((c) => {
    const t = (c.getAttribute("type") || "").toLowerCase();
    return t !== "hidden";
  });
  for (const c of controls.slice(0, 40)) {
    const r = c.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) continue;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (at && at !== c && isChallenge(at)) return "a challenge is covering the form";
  }
  return "";
})()`;
