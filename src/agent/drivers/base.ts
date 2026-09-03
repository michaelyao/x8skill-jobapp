import fs from "node:fs";
import path from "node:path";
import { TRANSCRIPT_PATH } from "../../config.js";
import type { Locator, Page } from "playwright";
import { loadSkillPicks, loadSkillRemovals, pillsToRemove, type SkillPill } from "../../knowledge/skillPlan.js";
import { datePartOf, datePartValue } from "../../core/dateParts.js";
import { isSensitive, preferredHearAboutUs } from "../llmAgent.js";
import { listChooserRow } from "../../core/listChooser.js";
import type { AtsDriver, DocumentUploads, FieldAnswer, FieldSpec, PageSnapshot, Root } from "../types.js";

/** Parse a human/ISO date string into y/m/day, or null. */
function parseDate(value: string): { y: number; m: number; day: number } | null {
  const v = value.trim();
  let m = v.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); // ISO-ish
  if (m) return { y: +m[1], m: +m[2], day: +m[3] };
  m = v.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); // US MM/DD/YYYY
  if (m) return { y: +m[3], m: +m[1], day: +m[2] };
  const dt = new Date(v);
  if (!Number.isNaN(dt.getTime())) return { y: dt.getFullYear(), m: dt.getMonth() + 1, day: dt.getDate() };
  const dt2 = new Date(`${v} 1`); // "June 2027" → 1st
  if (!Number.isNaN(dt2.getTime())) return { y: dt2.getFullYear(), m: dt2.getMonth() + 1, day: dt2.getDate() };
  return null;
}

/**
 * Compare an answer to an option's label without typography deciding the outcome.
 *
 * General Matter (Greenhouse) offered "Bachelor\u2019s Degree" with a typographic apostrophe while
 * the model answered "Bachelor's Degree" with a straight one. The option was ON SCREEN and in the
 * list we had already read — "saw: Associate\u2019s Degree | Bachelor\u2019s Degree" — and all four
 * match strategies missed it, including the substring fallback, because a single character
 * differed. The field then burned its full 90s deadline and was reported as "would not take it".
 *
 * Curly quotes, the various dashes and NBSP all come from the same class of mistake: text authored
 * in a rich editor compared against text a model typed. Fold them, collapse whitespace, lowercase.
 * Nothing here is lossy in a way that could match two genuinely different options.
 */
/**
 * Does what a control DISPLAYS answer for the value we wanted?
 *
 * Pure, so the react-select commit check can be tested without a browser: npm run test:committed.
 * Containment counts in both directions because a control shows the option's own wording — "United
 * States of America (+1)" for "+1", "Bachelor's Degree" for "Bachelor" — but only when the shorter
 * side is substantial, or "No" would vouch for "November".
 */
/**
 * Which of these option texts answers `want` (already normalised)? -1 for none.
 *
 * Pure and exported so the ladder can be tested and, more importantly, so the two places that need
 * it — the menu we read after typing and the menu we read after opening — cannot drift apart.
 * The order matters and each rung was earned:
 *   1. a phone dialling code ("+1") matches on the parenthesised code, preferring the United
 *      States, because +1 also covers Canada, Guam and American Samoa;
 *   2. the leading segment before a comma/paren, when the row says MORE than the value —
 *      "Python (Programming Language)" over the bare free-text row "python";
 *   3. exact; 4. leading segment; 5. containment either way.
 */
export function indexOfOption(texts: string[], want: string): number {
  const lead = (t: string) => normaliseOption(t).split(/[,(:\u2014\u2013-]/)[0].trim();
  if (/^\+\d{1,4}$/.test(want)) {
    const withCode = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.includes(`(${want})`));
    const us = withCode.find(({ t }) => /united states/i.test(t));
    const idx = (us ?? withCode[0])?.i;
    if (idx !== undefined) return idx;
  }
  let idx = texts.findIndex((t) => lead(t) === want && t.length > want.length);
  if (idx < 0) idx = texts.findIndex((t) => normaliseOption(t) === want);
  if (idx < 0) idx = texts.findIndex((t) => lead(t) === want);
  /**
   * Containment, but not in both directions equally.
   *
   * An option that CONTAINS the whole wanted value is safe — "United States +1" answers "United
   * States". The reverse, an option that is a FRAGMENT of what we wanted, silently narrows the
   * answer: asked for "Information Science", Greenhouse's discipline list has a row called
   * "Science", and picking it commits a claim the candidate never made. So a fragment must either
   * open the value ("Carnegie Mellon University" for "Carnegie Mellon University - Pittsburgh") or
   * account for most of it.
   */
  if (idx < 0) idx = texts.findIndex((t) => normaliseOption(t).includes(want));
  if (idx < 0)
    idx = texts.findIndex((t) => {
      const opt = normaliseOption(t);
      if (!opt || !want.includes(opt)) return false;
      return want.startsWith(opt) || opt.length >= want.length * 0.6;
    });
  return idx;
}

export function optionMatches(shown: string, wantNormalised: string): boolean {
  const got = normaliseOption(shown);
  const want = wantNormalised.trim();
  if (!got || !want) return false;
  if (got === want) return true;
  const shorter = got.length < want.length ? got : want;
  if (shorter.length < 4) return false;
  return got.includes(want) || want.includes(got);
}

export function normaliseOption(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02BC\u00B4\u2032`]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * RECOGNISING the submit control — never clicking it. Reaching it with every required field
 * filled is what "reached review" MEANS, so a wording this misses turns a finished application
 * into "did not reach review".
 *
 * Waymo's button reads "Submit my application". The old pattern wanted the two words adjacent or
 * the whole name to be exactly "submit", so a complete 19-field application — every required
 * question answered, resume attached — was recorded as a failure and never queued for approval.
 *
 * Clicking is guarded elsewhere and independently: SUBMIT_TEXT_BLOCKLIST is a substring test, so
 * "submit my application" was already blocked by "submit", and NEXT never matched it either.
 * Widening what we RECOGNISE cannot make anything clickable.
 */
export const SUBMIT =
  /^submit$|\bsubmit (my |your |the )?application\b|\bsend (my |your |the )?application\b|\bcomplete application\b/i;
// ^submit$ stays EXACT. Loosening it to /^submit\b/ matched "Submit a question to the recruiter",
// which is not this form's submit control — the case below was written for that and caught it.
export const APPLY = /^(apply|apply now|apply for this (job|role|position)|apply to this job|i'?m interested)\b/i;
export const NEXT = /^(next|continue|save and continue|review|save|proceed)\b/i;

/**
 * Shared DOM reader/filler for ATS forms. Works on a Root (Page or Frame) so it
 * handles both inline forms and iframe-embedded ones. Concrete drivers provide
 * detect / openApplication / resolveRoot / next as needed.
 */
/**
 * DOES THIS PAGE SAY THE APPLICATION IS IN?
 *
 * A pure function because it is the guard that turned a repeat submission at HP IQ from
 * seventeen hours of silence into a log line at the moment it happened — and because it MISSED
 * one. DV Trading's Greenhouse confirmation reads:
 *
 *   "Thank you for your interest in DV Trading! We've received your application and will be in
 *    touch if your background is a strong match for the role."
 *
 * and the old pattern missed it three separate ways: it wanted "we HAVE received" so a
 * CONTRACTION defeated it, it wanted "thank you for your interest in THE" so any company name
 * defeated it, and its "application received" alternative could not see the words in the order
 * every ATS actually writes them — "received your application". WREEFN sat in the queue as
 * awaiting_approval for eighteen days with the employer already holding the application, one
 * approval away from being sent twice.
 *
 * Biased towards DETECTING. A false positive marks a job engaged and loses the opportunity
 * quietly; a false negative sends a second application to an employer, which cannot be undone.
 * The doctrine here is already written down: re-submitting is not undoable.
 */
export function confirmsSubmission(pageText: string): boolean {
  const text = pageText
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    // Contractions, expanded so one apostrophe cannot hide a confirmation.
    .replace(/\bwe've\b/g, "we have")
    .replace(/\bwe're\b/g, "we are")
    .replace(/\byou've\b/g, "you have")
    .replace(/\bit's\b/g, "it is")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  /**
   * "once we have received your application" is a job description promising what happens NEXT,
   * not a confirmation. The forward-looking framings are excluded before the rest is tested.
   */
  const forwardLooking = /(once|after|when|if) (we|your application)[^.!?]{0,40}receiv/.test(text);
  const received =
    !forwardLooking &&
    /(we|they) (have|had) received your application|received your application[.! ]|your application (has been|was|is) (received|submitted|complete)/.test(
      text,
    );
  return (
    received ||
    /thank(s| you) for applying/.test(text) ||
    /thanks for your application/.test(text) ||
    /application (has been |was )?(successfully )?(submitted|received)/.test(text) ||
    /your application (to|for)[^.!?]{0,60}(has been|was) (received|submitted)/.test(text) ||
    // "Thank you for your interest in <anything>" only counts WITH a submission statement, which
    // the `received` test above already covers — on its own it is a job page's opening line.
    false
  );
}

/**
 * WHAT TO TYPE to make a long list show the answer.
 *
 * Two instructions from the candidate, and one rule reproduces both:
 *
 *   "Country/Territory — type 'United S' and pick United States."
 *   "Field of Study — type 'Information' and pick Computer and Information Science."
 *
 * Workday's taxonomy matches ANY WORD, not just the opening, so the best probe is whichever is
 * more discriminating: the eight-character opening, or the value's longest distinctive word.
 * Ordering those two by LENGTH gets both answers right — "United S" (8) beats "America" (7), and
 * "Information" (11) beats "Computer" (8). Dozens of entries begin with Computer; almost none
 * contain Information.
 *
 * The rest follow as fallbacks: four characters to open a list that a longer probe was too
 * specific for, the first word, the remaining words, and finally the whole value. Choosing the ROW
 * is still an exact match — a probe only has to make the list appear and contain the answer.
 */
export function searchProbes(value: string): string[] {
  const words = value
    .trim()
    .split(/[\s,/()]+/)
    .filter((w) => w.length >= 4 && !/^(and|the|for|with|from|your|this|that)$/i.test(w))
    .sort((a, b) => b.length - a.length);
  const opening = value.trim().slice(0, 8);
  const distinctive = words[0] ?? "";
  const leading = [opening, distinctive].filter(Boolean).sort((a, b) => b.length - a.length);
  return [
    ...new Set([
      ...leading,
      value.trim().slice(0, 4),
      value.trim().split(/\s+/)[0] ?? "",
      ...words.slice(1, 3),
      value.slice(0, 30),
    ]),
  ].filter((p) => p.length >= 2);
}

export abstract class GenericDriver implements AtsDriver {
  abstract readonly type: "workday" | "ashby" | "greenhouse" | "lever" | "workable" | "oracle";
  abstract detect(page: Page): Promise<boolean>;

  async openApplication(_page: Page): Promise<void> {
    // default: nothing to open (form is inline)
  }

  async resolveRoot(page: Page): Promise<Root> {
    return page;
  }

  async isAlreadyApplied(root: Root): Promise<boolean> {
    const text = (await root.locator("body").innerText().catch(() => "")).toLowerCase();
    return (
      text.includes("already applied") ||
      text.includes("application submitted") ||
      text.includes("thanks for applying") ||
      text.includes("you have applied") ||
      text.includes("you applied for this job") ||
      text.includes("view application")
    );
  }

  async next(_root: Root): Promise<boolean> {
    return false;
  }

  /**
   * Validation errors the FORM is showing. A page can be fully filled and still refuse to
   * advance: Pentair rejected a work-history entry with "Must end before start date" after
   * a start date of 12/2025 was written against an end of 4/2025, and the run reported only
   * that it was stuck — the actual reason was on screen the whole time.
   */
  async validationErrors(root: Root): Promise<string[]> {
    const SCRIPT = `(() => {
      var out = [];
      var nodes = document.querySelectorAll('[data-automation-id="errorMessage"], [data-automation-id*="error" i], [role="alert"], [class*="error" i]');
      for (var i = 0; i < nodes.length && out.length < 8; i++) {
        var el = nodes[i];
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) continue;
        var t = (el.innerText || "").replace(/\\s+/g, " ").trim();
        if (!t || t.length > 200) continue;
        if (!/error|must|required|invalid|cannot|can not|please/i.test(t)) continue;
        if (out.indexOf(t) < 0) out.push(t);
      }
      return out;
    })()`;
    return (await root.evaluate(SCRIPT).catch(() => [])) as string[];
  }

  /**
   * Is the page a SUBMISSION CONFIRMATION? Then this application went in, whatever we meant to do.
   *
   * The last line of defence, and the one that would have mattered. On 29 August six applications
   * were submitted by stray Enter keystrokes; every run afterwards reported "No next control —
   * stopping" and wrote `prefilled_pending_submit`, while the debug screenshot sitting on disk said
   * "Thank you for applying". Nobody looked at the page. The candidate found out from the
   * employers' emails, seventeen hours later.
   *
   * Preventing the cause is not enough on its own — the next way to submit by accident will not be
   * a keystroke this code knows about. Asking the page "did I just apply?" costs one read and turns
   * a silent catastrophe into a recorded, visible one.
   *
   * Deliberately narrow: these are the words an ATS shows AFTER a submission, not words that appear
   * on a form. "Submit application" as a button label must never match.
   */
  async submissionConfirmed(root: Root): Promise<boolean> {
    const text = ((await root.locator("body").innerText({ timeout: 3_000 }).catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (!text) return false;
    return confirmsSubmission(text);
  }

  /** Click the final Submit button. Only invoked after explicit user confirmation. */
  async submit(root: Root): Promise<boolean> {
    const btn = root.getByRole("button", { name: SUBMIT }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click().catch(() => undefined);
      return true;
    }
    return false;
  }

  async read(root: Root): Promise<PageSnapshot> {
    // String form so tsx/esbuild doesn't inject helpers unavailable in the browser.
    const READ_SCRIPT = `(() => {
      const isVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
      const labelFor = (c) => {
        const id = c.getAttribute("id");
        let label = "";
        if (id) { const esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id; const l = document.querySelector('label[for="' + esc + '"]'); if (l) label = l.innerText; }
        if (!label) label = c.getAttribute("aria-label") || "";
        if (!label) { const l = c.closest("label"); if (l) label = l.innerText; }
        if (!label) { const l = c.closest("div,fieldset,li"); const lab = l && l.querySelector("label"); if (lab) label = lab.innerText; }
        // Lever custom questions: <li class="application-question"> carries the question
        // text in an .application-label, while the control sits in a sibling
        // .application-field — so nothing above finds it and we used to fall through to
        // the raw name ("cards[<uuid>][field5]").
        if (!label) {
          const aq = c.closest('[class*="application-question" i]');
          const lab = aq && aq.querySelector('[class*="application-label" i], label');
          if (lab && lab.innerText) label = lab.innerText;
        }
        // Field-entry container (e.g. Ashby wraps the react-datepicker several
        // levels below the question label). Walk up to it and take its label text.
        if (!label) {
          const fe = c.closest('[class*="fieldEntry" i], [class*="field-entry" i], [class*="formField" i], fieldset, li');
          if (fe) {
            const lab = fe.querySelector('label, legend, h1, h2, h3, h4, [class*="label" i]');
            if (lab && lab.innerText) label = lab.innerText;
            else { const first = (fe.innerText || "").split("\\n").map((s) => s.trim()).filter(Boolean)[0]; if (first) label = first; }
          }
        }
        if (!label) label = c.getAttribute("placeholder") || c.getAttribute("name") || c.getAttribute("value") || "";
        return (label || "").replace(/\\s+/g, " ").trim();
      };
      /**
       * A honeypot is a real, focusable input that no human ever sees — filling it is a
       * self-report that we are a bot. Oracle HCM ships one on its apply screen
       * (name="honey-pot", aria-hidden="true"), and it PASSES the isVisible test above, so
       * without this it is read as an ordinary field and answered on every application.
       *
       * The test is deliberately narrow: aria-hidden ("not for humans") or a name that says so.
       * Size and clipping are NOT used — that is exactly how a custom-styled checkbox hides its
       * real input, and Oracle's own REQUIRED "I agree with the terms and conditions" box is 0x0
       * and clipped. Skipping that would leave a required field unfillable and stall the run
       * against the required-field gate, which is a worse failure than the trap.
       */
      const isBotTrap = (el) => {
        if (el.getAttribute("aria-hidden") === "true") return true;
        return /honey|hpot|_bot\\b|\\bbot_|trap|nospam/i.test((el.getAttribute("name") || "") + " " + (el.id || ""));
      };
      /**
       * A DISABLED CONTROL IS NOT A REQUIRED GAP.
       *
       * Workday hides a Work Experience row's "To" date the moment "I currently work here" is
       * ticked — the input stays in the DOM, disabled. read() reported it anyway, so on Michelin
       * row 1 (Amazon, "Aug 2026 – Present") the To month and year came back required and empty,
       * the gate refused to advance, and the application stopped one field short of Review with
       * nothing anybody could do about it: there is no box on the page to type into.
       *
       * DISABLED only, never READONLY. A Workday prompt is a readonly input you drive by clicking,
       * and skipping those would blind the reader to most of the form.
       */
      const isDisabled = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";
      const controls = [...document.querySelectorAll("input:not([type=hidden]):not([type=file]), textarea, select")]
        .filter(isVisible)
        .filter((el) => !isBotTrap(el))
        .filter((el) => !isDisabled(el));
      const out = [];
      let i = 0;
      let gi = 0;
      const seenRadio = {};
      for (const c of controls) {
        // Skip known bot-trap/honeypot fields (must stay empty).
        const aid = (c.getAttribute("data-automation-id") || "").toLowerCase();
        if (aid === "beecatcher" || /honeypot|donotfill/i.test(aid + " " + (c.getAttribute("name") || ""))) continue;
        const tag = c.tagName.toLowerCase();
        const rawType = (c.getAttribute("type") || "").toLowerCase();

        // Group radios by name → one field with options (option order == radio order).
        if (rawType === "radio") {
          const name = c.getAttribute("name") || "";
          if (name && seenRadio[name]) continue;
          const radios = name ? controls.filter((x) => (x.getAttribute("name") || "") === name && (x.getAttribute("type") || "").toLowerCase() === "radio") : [c];
          let key;
          if (name) { key = '[name="' + name + '"]'; }
          else { const dk = "rg" + (i++); radios.forEach((r) => r.setAttribute("data-agent-key", dk)); key = '[data-agent-key="' + dk + '"]'; }
          const options = radios.map(labelFor).filter(Boolean);
          let q = "";
          const rg = c.closest('[role="radiogroup"], fieldset');
          if (rg) q = rg.getAttribute("aria-label") || (rg.querySelector("legend") ? rg.querySelector("legend").innerText : "");
          // Prefer the enclosing field container's question text (Workday formField,
          // Ashby fieldEntry) — the generic div-walk otherwise yields just "choice".
          if (!q) { const ff = c.closest('[data-automation-id^="formField"], [class*="fieldEntry" i], [class*="field-entry" i]'); if (ff) q = ff.innerText || ""; }
          // Lever radio cards: the question lives on the enclosing
          // <li class="application-question">, NOT on the option list's own container.
          // Without this the div-walk below finds only "Yes No", which the option
          // stripping then erases — leaving the raw "cards[<uuid>][fieldN]" name.
          if (!q) { const aq = c.closest('[class*="application-question" i]'); if (aq) q = aq.innerText || ""; }
          if (!q) { let w = c.closest("div"); for (let k = 0; k < 4 && w; k++) { const t = (w.innerText || "").trim(); if (t && t.length > 3) { q = t; break; } w = w.parentElement; } }
          for (const o of options) if (o) q = q.split(o).join(" ");
          q = q.replace(/\\*/g, " ").replace(/\\brequired\\b/gi, " ").replace(/\\s+/g, " ").trim().slice(0, 160) || name || "choice";
          if (name) seenRadio[name] = true;
          const rFilled = radios.some((r) => r.checked);
          // Required only if the group's own container shows an asterisk / required
          // marker — NOT hardcoded (optional preference radios were over-blocking).
          const rgc = c.closest('[data-automation-id^="formField"], [role="radiogroup"], fieldset, [class*="fieldEntry" i], [class*="field-entry" i]');
          const rReq =
            radios.some((r) => r.hasAttribute("required") || r.getAttribute("aria-required") === "true") ||
            (rg && rg.getAttribute("aria-required") === "true") ||
            (rgc ? /\\*/.test(rgc.innerText || "") || /\\brequired\\b/i.test(rgc.getAttribute("aria-label") || "") : false);
          out.push({ key, label: q, type: "radio", options, required: rReq, widget: "", filled: rFilled });
          continue;
        }

        // Prefer stable id/name selectors (React re-renders strip custom attrs).
        const idAttr = c.getAttribute("id");
        const nameAttr = c.getAttribute("name");
        let key;
        if (idAttr) key = '[id="' + idAttr + '"]';
        else if (nameAttr) key = '[name="' + nameAttr + '"]';
        else { const dk = "f" + (i++); c.setAttribute("data-agent-key", dk); key = '[data-agent-key="' + dk + '"]'; }
        let label = labelFor(c).slice(0, 140);
        // Bare sub-field labels are meaningless alone. A Workday experience page presents 44
        // fields labelled "Month" and 52 labelled "Year" at once, so nothing told the agent
        // WHICH entry or WHICH end of a date range it was filling: it wrote a start date of
        // 12/2025 against an end date of 4/2025 and Workday refused with "Must end before
        // start date". Prefix them with the nearest identifying ancestors.
        // A REPEATED block (Work Experience 1/2/3, Education 1/2, Language 1/2) presents the
        // same labels over and over: three fields called "Company*", three called "Job Title*".
        // Without the block name nothing — not the agent, not the reviewer reading the website,
        // not the comparison that decides whether a submit matches what was approved — can tell
        // which position is which. Workday names each block in a heading or a panelSet item id;
        // take that and put it in front of the label.
        var blockName = "";
        var upB = c.parentElement;
        for (var lb = 0; lb < 12 && upB && !blockName; lb += 1) {
          var aidB = upB.getAttribute("data-automation-id") || "";
          // The block's own heading is the best name there is — it is what the PAGE calls the
          // block, so the reviewer reading "Work Experience 2 — Company*" sees exactly what
          // they would see on screen. Prefer it over any id we could derive.
          var headB = upB.querySelector("h2, h3, h4, legend");
          var headText = headB && headB.innerText ? headB.innerText.replace(/\\s+/g, " ").trim().slice(0, 40) : "";
          if (/^(work experience|experience|employment|education|school|languages?|certifications?|websites?)\\s*\\d*$/i.test(headText)) {
            blockName = headText;
            // A SECTION heading ("Work Experience") names the group, not the row. Workday's
            // review page numbers the rows 1..6; the form does not, so seven employment blocks
            // all arrived as "Work Experience — Company*" and collapsed onto one another —
            // which is why the website showed a single experience while the screenshot showed
            // six. Derive the ordinal from the row's position among its sibling rows.
            if (!/\\d\\s*$/.test(headText)) {
              var rowEl = c;
              while (rowEl && rowEl.parentElement !== upB) rowEl = rowEl.parentElement;
              if (rowEl && rowEl.parentElement === upB) {
                var sibs = [];
                for (var sx = 0; sx < upB.children.length; sx += 1) {
                  var ch = upB.children[sx];
                  if (ch.querySelector && ch.querySelector("input, select, textarea")) sibs.push(ch);
                }
                if (sibs.length > 1) {
                  var pos = sibs.indexOf(rowEl);
                  if (pos >= 0) blockName = headText + " " + (pos + 1);
                }
              }
            }
            break;
          }
          // No heading: derive one from the repeated panel's id, taking the NAME from the
          // enclosing section (workExperienceSection) and the ORDINAL from the item itself.
          if (/^panelSet-item|^workExperience|^education|^language/i.test(aidB)) {
            var setB = upB.parentElement ? upB.parentElement.closest('[data-automation-id$="Section"]') : null;
            var setName = setB ? (setB.getAttribute("data-automation-id") || "").replace(/Section$/i, "") : "";
            var ord = (aidB.match(/(\\d+)\\s*$/) || [])[1] || "";
            var pretty = (setName || aidB.replace(/[-_]?\\d+\\s*$/, "")).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").trim();
            if (pretty && !/^panel ?set/i.test(pretty)) {
              blockName = (pretty.charAt(0).toUpperCase() + pretty.slice(1) + (ord ? " " + ord : "")).trim();
              break;
            }
          }
          upB = upB.parentElement;
        }
        // Prefix ONLY the labels that actually repeat per block. A section heading otherwise
        // gets glued onto every neighbouring question that happens to sit in the same section.
        var repeats = /^(job title|company|employer|location|role description|description|i currently work here|from|to|month|year|day|degree|school|university|field of study|major|language|proficiency|title|start date|end date)\\b/i.test(label);
        if (blockName && label && repeats && label.toLowerCase().indexOf(blockName.toLowerCase()) < 0) {
          label = (blockName + " \u2014 " + label).slice(0, 190);
        }

        if (/^(month|year|day|from|to)$/i.test(label) || /\u2014 (month|year|day|from|to)$/i.test(label)) {
          const parts = [];
          let up2 = c.parentElement;
          for (let lv = 0; lv < 10 && up2 && parts.length < 2; lv += 1) {
            let t2 = "";
            // DIRECT children only. querySelector searches descendants, so once this walk
            // reaches a container holding BOTH the From and the To fieldset it returns whichever
            // legend comes first — "From*" — even while we are filling the To field. That is how
            // RTX Work Experience 2's empty To month arrived labelled
            // "From* — To* — Work Experience 2 — Month": both ends in one label, so the agent
            // could not tell which it was being asked for, left it blank, and Workday answered
            // "The field To is required and must have a value" and bounced the page back.
            const lg2 = up2.querySelector(":scope > legend, :scope > h2, :scope > h3, :scope > h4");
            if (lg2 && lg2.innerText) t2 = lg2.innerText;
            if (!t2) {
              const aid3 = up2.getAttribute("data-automation-id") || "";
              if (/^formField-/.test(aid3)) t2 = aid3.replace(/^formField-/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
              else if (/section/i.test(aid3)) t2 = aid3.replace(/([a-z])([A-Z])/g, "$1 $2");
            }
            t2 = (t2 || "").replace(/\\s+/g, " ").trim();
            if (t2 && t2.toLowerCase() !== label.toLowerCase() && parts.indexOf(t2) < 0) parts.unshift(t2.slice(0, 60));
            up2 = up2.parentElement;
          }
          if (parts.length) label = (parts.join(" \u2014 ") + " \u2014 " + label).slice(0, 190);
        }
        // Both passes can contribute the same ancestor, giving "Work Experience 1 — From* —
        // Work Experience 1 — Month". Collapse repeats, keeping the first occurrence so the
        // block still leads the label.
        if (label.indexOf(" \u2014 ") >= 0) {
          var segs = label.split(" \u2014 ");
          var kept = [];
          for (var sg = 0; sg < segs.length; sg += 1) {
            var seg = segs[sg].trim();
            var dup = false;
            for (var kk = 0; kk < kept.length; kk += 1) { if (kept[kk].toLowerCase() === seg.toLowerCase()) dup = true; }
            if (seg && !dup) kept.push(seg);
          }
          label = kept.join(" \u2014 ");
        }
        // Workday "prompt" fields are multi-selects whose control is a BARE <input> — no
        // role, no select__ class — so they were read as free text: no options captured, the
        // agent answered from general knowledge ("LinkedIn" when the list only offers
        // Advertising / Employee Referral / Job Board), and fill() typed it in. Workday then
        // reported "0 items selected" and refused to advance.
        const wdPrompt = !!c.closest('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"]');
        const isReactSelect = c.getAttribute("role") === "combobox" || !!c.closest('[class*="select__"]') || wdPrompt;
        // A type-to-filter combobox (react-select input; Greenhouse's School /
        // Discipline typeahead) only renders an async SLICE of its real options when
        // opened, so whatever we capture is a sample — never a complete allowlist.
        const searchable = isReactSelect && tag === "input" && !c.readOnly && !c.disabled && !wdPrompt;
        let type = tag === "textarea" ? "textarea" : tag === "select" ? "single_select" : rawType === "checkbox" ? "checkbox" : "text";
        if (isReactSelect) type = "single_select";
        // Date fields (native date input, or a text picker with a date placeholder
        // like Ashby's "Pick date...") need date-formatted values, not free text.
        const ph = c.getAttribute("placeholder") || "";
        if (!isReactSelect && (rawType === "date" || /\\bdate\\b/i.test(ph) || /mm.?dd.?yyyy|dd.?mm.?yyyy|yyyy.?mm.?dd/i.test(ph))) type = "date";
        const options = tag === "select" ? [...c.querySelectorAll("option")].map((o) => (o.textContent || "").trim()).filter(Boolean) : [];
        let required = c.hasAttribute("required") || c.getAttribute("aria-required") === "true" || /\\*/.test(label);
        // A checkbox that is one of several in the same field group is part of a
        // "select all that apply" list — the GROUP may be required (pick >=1) but no
        // individual box is. Only a lone checkbox (consent) stays individually required.
        var groupKey = "";
        var groupLabel = "";
        var groupRequired = false;
        if (rawType === "checkbox") {
          const nm = c.getAttribute("name");
          const sameName = nm ? controls.filter((x) => x.getAttribute("name") === nm && (x.getAttribute("type") || "").toLowerCase() === "checkbox").length : 1;
          // Find the nearest ancestor that actually holds more than one checkbox, rather
          // than trusting a fixed list of container classes. Workday puts each box of its
          // "Please check one of the boxes below" group in its OWN formField wrapper, so the
          // fixed-list lookup saw a group of one: the question was never attached, the agent
          // treated each box as an independent yes/no and said No to all three, and the
          // required "pick exactly one" ended up with nothing picked.
          let grp = c.closest('[data-automation-id^="formField"], [role="group"], fieldset, [class*="fieldEntry" i], [class*="field-entry" i], [class*="application-question" i], [class*="application" i]');
          if (!grp || grp.querySelectorAll('input[type="checkbox"]').length < 2) {
            let up = c.parentElement;
            for (let lvl = 0; lvl < 8 && up; lvl += 1) {
              // Only accept a container holding NOTHING BUT checkboxes — that is an option
              // list. Climbing on any ancestor with two checkboxes swept up unrelated fields
              // from elsewhere on the page and mislabelled them as one question's options.
              const others = up.querySelectorAll('input:not([type=checkbox]):not([type=hidden]), select, textarea').length;
              const boxes = up.querySelectorAll('input[type="checkbox"]').length;
              if (boxes >= 2 && boxes <= 15 && others === 0) { grp = up; break; }
              if (others > 0) break; // left this question's subtree — stop climbing
              up = up.parentElement;
            }
          }
          /**
           * SECOND PATH: THE BOXES ARE CONTIGUOUS EVEN IF THE CONTAINER HOLDS OTHER FIELDS.
           *
           * The strict climb above demands an ancestor holding NOTHING but checkboxes, and on
           * Workday's Self Identify page there is none: the smallest ancestor holding all three
           * CC-305 boxes also holds Name, Employee ID, Date and Language. So no group formed, the
           * question was never attached, the agent answered each box as its own independent
           * yes/no and said No to all three — and the form came back "The field Please check one
           * of the boxes below: is required and must have a value" with nothing ticked. The
           * comment above describes this exact failure; the strict rule just could not reach it.
           *
           * What makes an option list an option list is that the boxes sit TOGETHER: no other
           * input between the first and the last. Fields above or below are somebody else's
           * question and cannot be swept in, which is the protection the others===0 rule was
           * reaching for.
           */
          if (!grp || grp.querySelectorAll('input[type="checkbox"]').length < 2) {
            let up = c.parentElement;
            for (let lvl = 0; lvl < 8 && up; lvl += 1) {
              const inputs = Array.from(up.querySelectorAll('input:not([type=hidden]), select, textarea'));
              const isBox = (el) => (el.getAttribute("type") || "").toLowerCase() === "checkbox";
              const boxAt = inputs.map((el, ix) => (isBox(el) ? ix : -1)).filter((ix) => ix >= 0);
              if (boxAt.length >= 2 && boxAt.length <= 15) {
                const between = inputs.slice(boxAt[0], boxAt[boxAt.length - 1] + 1).filter((el) => !isBox(el));
                if (!between.length) { grp = up; break; }
              }
              up = up.parentElement;
            }
          }
          const grpCount = grp ? grp.querySelectorAll('input[type="checkbox"]').length : 1;
          const inGroup = sameName > 1 || grpCount > 1;
          if (inGroup && required) required = false;
          // Carry the GROUP's question into each option's label. Without it a
          // "select all that apply" list arrives as bare options — "Computer Science",
          // "Physics", "IMO or EGMO" — and nothing can tell what is being asked, so every
          // one of them came back unanswered.
          if (inGroup && grp) {
            let q = "";
            const lab = grp.querySelector('legend, [data-automation-id="richText"], label, [class*="label" i]');
            if (lab && lab.innerText) q = lab.innerText;
            /**
             * When the container also holds other fields, its FIRST label is that field's — on
             * Self Identify it is "Name". The question is the last label-ish thing BEFORE the
             * first checkbox, so walk back from the box itself.
             */
            const firstBox = grp.querySelector('input[type="checkbox"]');
            const boxOwnLabel = firstBox ? labelFor(firstBox) : "";
            if (firstBox && (!q || (boxOwnLabel && q.indexOf(boxOwnLabel) < 0 && grp.querySelectorAll('input:not([type=hidden]):not([type=checkbox]), select, textarea').length > 0))) {
              const marks = Array.from(grp.querySelectorAll('legend, [data-automation-id="richText"], label, [class*="label" i], p, h3, h4'));
              let best = "";
              for (const m of marks) {
                if (!(m.compareDocumentPosition(firstBox) & Node.DOCUMENT_POSITION_FOLLOWING)) continue; // must precede the box
                const t = (m.innerText || "").replace(/\\s+/g, " ").trim();
                if (!t || t.length > 160) continue;
                if (boxOwnLabel && t.indexOf(boxOwnLabel) >= 0) continue; // that is the option, not the question
                best = t;
              }
              if (best) q = best;
            }
            if (!q) q = grp.innerText || "";
            // Strip the option labels out of the container text so only the question is left.
            for (const box of grp.querySelectorAll('input[type="checkbox"]')) {
              const t = labelFor(box);
              if (t) q = q.split(t).join(" ");
            }
            var rawQ = q;
            q = q.replace(/\\*/g, " ").replace(/\\brequired\\b/gi, " ").replace(/\\s+/g, " ").trim();
            if (q && q.toLowerCase() !== label.toLowerCase()) label = (q.slice(0, 110) + " — " + label).slice(0, 190);
            // The GROUP can be required even though no single box is ("Please check one of
            // the boxes below:*"). Carry that so the gate can insist on at least one tick
            // instead of accepting three untouched boxes as answered.
            if (!grp.getAttribute("data-agent-group")) grp.setAttribute("data-agent-group", "g" + (gi++));
            groupKey = grp.getAttribute("data-agent-group");
            groupLabel = q.slice(0, 110);
            groupRequired = /\\*/.test(rawQ) || /\\brequired\\b/i.test(rawQ);
          }
        }
        // Does the control currently hold a value? (used to gate advancing on empty required fields)
        let filled;
        if (isReactSelect) {
          const shell = c.closest('[class*="select__control"]') || c.closest('[class*="select__container"]') || c.closest('[class*="select-shell"]');
          filled = !!(shell && shell.querySelector('[class*="single-value"], [class*="multi-value"]'));
          if (!filled) {
            // Workday: a committed value is a selectedItem row inside the form field, and the
            // prompt label reads "N items selected". Looking only for react-select's marker
            // reported Country Phone Code as empty when it was in fact selected, so the gate
            // blocked a field that was already answered.
            var wdBox = c.closest('[data-automation-id^="formField"]');
            if (wdBox) {
              if (wdBox.querySelector('[data-automation-id="selectedItem"]')) filled = true;
              else {
                var pl = wdBox.querySelector('[data-automation-id="promptSelectionLabel"]');
                var pm = pl && (pl.innerText || "").match(/(\\d+)\\s+items?\\s+selected/i);
                if (pm && +pm[1] > 0) filled = true;
              }
            }
          }
        } else if (tag === "select") {
          const sel = c.options[c.selectedIndex];
          const txt = sel ? (sel.textContent || "").trim() : "";
          filled = !!(c.value && !/^(select|choose|please select|--|\\s*)$/i.test(txt));
        } else if (rawType === "checkbox") {
          filled = c.checked;
        } else {
          filled = (c.value || "").trim() !== "";
        }
        out.push({ key, label, type, options, required, widget: isReactSelect ? "react-select" : "", searchable, filled, groupKey, groupLabel, groupRequired });
      }

      return out;
    })()`;
    const rawFields = (await root.evaluate(READ_SCRIPT)) as Array<{
      key: string;
      label: string;
      type: string;
      options: string[];
      required: boolean;
      widget: string;
      searchable?: boolean;
      filled: boolean;
      groupKey?: string;
      groupLabel?: string;
      groupRequired?: boolean;
    }>;

    /**
     * Workday folds its inline validation message INTO the field's label once a page has been
     * rejected: "Are you currently enrolled in a degree seeking program? Error: The field ... is
     * and must have a value." The same question then arrives TWICE — once clean, once with the
     * error glued on — and both count as required. Filling one leaves the other "empty", so the
     * required-field gate can never be satisfied and a fill that DID work is reported as blocked.
     * That is what made RTX log "✓ What is your Current Degree Program?" and still stop on it.
     *
     * The message belongs in validationErrors(), which already reports it. Cut it off the label.
     */
    const stripError = (label: string): string =>
      label
        .replace(/\s*Error:\s[\s\S]*$/i, "")
        .replace(/\s*Error\s*-\s*Page Error[\s\S]*$/i, "")
        .replace(/\s+/g, " ")
        .trim();

    const fields: FieldSpec[] = rawFields
      .filter((f) => f.label && !SUBMIT.test(f.label))
      .map((f): FieldSpec => ({
        key: f.key,
        label: stripError(f.label),
        type: f.type as FieldSpec["type"],
        required: f.required,
        options: f.options.length ? f.options : undefined,
        sensitive: isSensitive(f.label),
        widget: f.widget === "react-select" ? "react-select" : f.widget === "workday-select" ? "workday-select" : undefined,
        searchable: f.searchable || undefined,
        filled: f.filled,
        groupKey: f.groupKey || undefined,
        groupLabel: f.groupLabel || undefined,
        groupRequired: f.groupRequired || undefined,
      }))
      // Stripping the error makes the clean and error-suffixed copies identical. Collapse them:
      // one question is one field, and a duplicate the gate can never satisfy is worse than none.
      .filter((f, i, all) => {
        const first = all.findIndex((o) => o.label === f.label && o.type === f.type);
        if (first === i) return true;
        if (f.filled && !all[first].filled) all[first].filled = true;
        return false;
      });

    // For custom dropdowns (react-select etc.), capture the real options so the
    // agent picks an EXACT option instead of us typing a free value.
    for (const field of fields) {
      // Capture options for every dropdown (incl. EEO/self-ID) so the agent picks
      // the exact option from the candidate's known data.
      if ((field.widget === "react-select" || field.widget === "workday-select") && !field.options) {
        const opts = await this.captureSelectOptions(root, field.key).catch(() => undefined);
        if (opts && opts.length) field.options = opts;
      }
    }

    // A captured option list is not always the WHOLE list. Workday's "Type to Add Skills" and
    // "Field of Study" open on the first alphabetical page of a taxonomy — fourteen entries,
    // Accounting through Ancient Studies, every one an A — while "How Did You Hear About Us?"
    // really does offer five choices with five different initials. Presenting a page as a
    // closed allowlist is why Skills came back "no answer available" for five turns although
    // the resume states the skills plainly: the model was told its true answer was not allowed.
    // Applied here, after options are attached, so it covers every driver's sampling path.
    for (const field of fields) {
      if (!field.options || field.options.length < 8) continue;
      const initials = new Set(field.options.map((o) => (o[0] ?? "").toUpperCase()));
      if (!field.searchable) {
        if (initials.size === 1) field.searchable = true;
        continue;
      }
      /**
       * And the inverse: a type-to-search box whose captured list SPANS the alphabet is showing
       * the whole taxonomy, not a page of it, so the agent should choose from it rather than
       * answer from general knowledge. Greenhouse's Discipline offers all 72 disciplines at once
       * including "Information Systems" — the candidate's actual degree — and the agent, given
       * only the first ten as a sample, answered "Information Science", which that list does not
       * contain and no amount of searching will find.
       *
       * A single initial still means a page (Workday's Field of Study opens on Accounting through
       * Ancient Studies), and that case keeps its freedom to answer.
       */
      if (initials.size >= 6) field.searchable = false;
    }

    return { url: root.url(), fields, submitReady: await this.hasSubmit(root), nextAvailable: await this.hasNext(root) };
  }

  /** Open a custom combobox, read ITS OWN option labels (scoped to its container), and close it. */
  protected async captureSelectOptions(root: Root, keySelector: string): Promise<string[]> {
    const control = root.locator(keySelector).first();
    if (!(await control.count())) return [];
    const page = control.page();
    // Close any prior menu, and CHECK that it closed. One Escape is not always enough, and a menu
    // the previous field left open is read as this field's option list — which is how a "How did
    // you hear about us?" field came back offering 234 country dialling codes.
    for (let clear = 0; clear < 3; clear += 1) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150);
      if (!(await root.locator('[data-automation-id="activeListContainer"]').count().catch(() => 0))) break;
    }
    await control.scrollIntoViewIfNeeded().catch(() => undefined);
    await control.click().catch(() => undefined);
    await page.waitForTimeout(400);
    let opts = await this.scopedOptions(root, keySelector, control);
    if ((await opts.count().catch(() => 0)) === 0) {
      // Open via keyboard (won't toggle-close like a second click would).
      await control.press("ArrowDown").catch(() => undefined);
      await page.waitForTimeout(350);
      opts = await this.scopedOptions(root, keySelector, control);
    }
    const count = await opts.count().catch(() => 0);
    const seen = new Set<string>();
    const list: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = ((await opts.nth(i).innerText({ timeout: 1_000 }).catch(() => "")) || "").trim();
      // Workday renders the same option as menuItem, promptLeafNode AND promptOption, so the
      // raw list arrives in triplicate.
      if (t && !/^select(\.\.\.| one)?$/i.test(t) && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        list.push(t);
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(120);
    return list;
  }

  /** Options locator scoped to THIS control's own react-select container (not a neighbor's). */
  protected async scopedOptions(root: Root, keySelector: string, control: Locator): Promise<Locator> {
    // Workday first, and ONLY its promptOption rows. Measured on a live prompt: clicking the
    // role="option" node (data-automation-id="menuItem") does nothing — "0 items selected" —
    // while clicking promptOption commits ("1 item selected"). menuItem precedes promptOption
    // in DOM order, so a selector matching both always clicked the dead one.
    // The OPEN menu first. Workday renders it as activeListContainer[role=listbox], and its rows
    // are the only promptOption nodes that are actually selectable — the ones already chosen live
    // on as chips inside the field itself. Reading those chips is what made every search after
    // the first return the previous search's picks, twice over.
    /**
     * Workday's OPEN menu first, and only its promptOption rows. Measured on a live prompt:
     * clicking the role="option" node does nothing — "0 items selected" — while clicking
     * promptOption commits. menuItem precedes promptOption in DOM order, so a selector matching
     * both always clicked the dead one.
     *
     * The ordering here is the ORIGINAL, and the case that was used to justify changing it does not
     * support the change. Asking the control for its own aria-controls listbox first reads better —
     * a control that names a listbox is telling us which popup is its own — and was reverted on the
     * evidence that Uline's "How Did You Hear About Us?" went from 44 captured options to 4
     * ("English", "Español", the country code twice). It did not: the 44-option captures are from
     * 16 and 19 August, and BOTH of today's captures — before and after that change — read 4. The
     * comparison was between rounds months apart, not between two versions of this code.
     *
     * So the ordering question is open, and this is the long-tested arrangement. What is NOT open:
     * something about that Uline page changed between August and now, and its option list is being
     * read from a language switcher. That needs a live capture behind the Workday login, and it is
     * not a matching bug — do not "fix" it here.
     */
    const openMenu = root.locator('[data-automation-id="activeListContainer"] [data-automation-id="promptOption"]');
    if ((await openMenu.count().catch(() => 0)) > 0) return openMenu;

    // The control names its own listbox while open. Ask IT next: a root-scoped activeListContainer
    // query returns the first popup in the DOM, and on a page with several prompt fields that is a
    // neighbour's.
    const ownedId =
      (await control.getAttribute("aria-controls", { timeout: 1_000 }).catch(() => null)) ||
      (await control.getAttribute("aria-owns", { timeout: 1_000 }).catch(() => null));
    if (ownedId) {
      const owned = root.locator(
        `[id="${ownedId}"] [data-automation-id="promptOption"], [id="${ownedId}"] [role="option"], [id="${ownedId}"] [class*="select__option"]`,
      );
      if ((await owned.count().catch(() => 0)) > 0) return owned;
    }
    // Otherwise the popup Workday renders next to THIS field, not the first one on the page.
    const nearby = root
      .locator(keySelector)
      .locator(
        'xpath=ancestor::*[@data-automation-id="multiSelectContainer" or @data-automation-id="multiselectInputContainer" or starts-with(@data-automation-id,"formField")][1]',
      )
      // Exclude anything under selectedItemList: those are the values already committed to this
      // field, not options on offer.
      .locator(
        'xpath=.//*[@data-automation-id="promptOption" or @role="option"][not(ancestor::*[@data-automation-id="selectedItemList" or @data-automation-id="selectedItem"])]',
      );
    if ((await nearby.count().catch(() => 0)) > 0) return nearby;
    const wdOpen = root.locator('[data-automation-id="activeListContainer"] [data-automation-id="promptOption"]');
    if ((await wdOpen.count().catch(() => 0)) > 0) return wdOpen;
    const container = root
      .locator(keySelector)
      .locator('xpath=ancestor-or-self::*[contains(@class,"select__container") or contains(@class,"select-shell") or contains(@class,"select__control")][1]');
    // promptOption is Workday's option row; without it the only candidates found were
    // react-select's, so a Workday prompt got the value TYPED into its search box and
    // never selected — the box then read "LinkedIn" while Workday still called the field
    // empty ("is required and must have a value").
    const OPTION_SELECTOR = '[class*="select__option"], [role="option"], [data-automation-id="promptOption"]';
    const inContainer = container.locator(OPTION_SELECTOR);
    if ((await inContainer.count().catch(() => 0)) > 0) return inContainer;
    // Menu portaled outside the container → scope by the id it controls (never global).
    const menuId =
      (await control.getAttribute("aria-controls").catch(() => null)) ||
      (await control.getAttribute("aria-owns").catch(() => null));
    if (menuId) return root.locator(`[id="${menuId}"] [role="option"], [id="${menuId}"] [class*="select__option"]`);
    // Workday renders its prompt list in a popup outside the field with no aria-controls.
    // Scope to the OPEN menu (activeListContainer): a bare global promptOption query also
    // matched the neighbouring field's committed pills, which live in selectedItemList —
    // that leaked "United States of America (+1)" from Country Phone Code into the options
    // offered for "How Did You Hear About Us?".
    const open = root.locator('[data-automation-id="activeListContainer"]').locator(OPTION_SELECTOR);
    if ((await open.count().catch(() => 0)) > 0) return open;
    return inContainer;
  }

  /** A skills prompt is filled from skill.txt, so it needs no answer — see fillsWithoutAnswer. */
  fillsWithoutAnswer(field: FieldSpec): boolean {
    return /\b(add skills?|^skills?)\b/i.test(field.label);
  }

  /**
   * Is a resume already attached, according to the PAGE?
   *
   * uploadDocuments verifies by the filename appearing, precisely because Greenhouse detaches the
   * input and files.length then lies — 130 log lines claimed an upload had failed when it had
   * worked, and the document gate blocked finished applications over it. The same lesson had not
   * reached the case where the run never visits the upload step at all: resuming a Workday draft
   * starts at My Information, nothing is uploaded, and the gate refused an application that HAS a
   * resume with "no resume was attached".
   */
  async hasResumeOnPage(root: Root, fileName: string): Promise<boolean> {
    return this.showsFileName(root, fileName).catch(() => false);
  }

  async fill(root: Root, field: FieldSpec, answer: FieldAnswer): Promise<boolean> {
    const locator = root.locator(field.key).first();
    if (!(await locator.count())) return false;
    const value = answer.value;

    // A skills prompt is a MULTI-select over a taxonomy that names things its own way, so the
    // mapping is curated in skill.txt rather than guessed: type the heading, then tick the exact
    // entries listed under it. Nothing else can know that "Python" means eight separate rows.
    /**
     * A SKILLS PROMPT IS THE PLAN'S, AND NOTHING ELSE MAY TYPE INTO IT.
     *
     * Two faults here, both mine, both live on a real application.
     *
     * The condition required `searchable || widget === "workday-select"`, and on Michelin neither
     * held, so the plan never ran. The fall-through then typed the ANSWER into the box — and I had
     * just set that answer to a marker, "(the entries listed in skill.txt)", so the run searched
     * the taxonomy for "skill.txt" and was offered "Skill Development | Skill Marketing". One more
     * step and it would have added a skill the candidate has never claimed, on a page whose whole
     * purpose is that the taxonomy names things its own way.
     *
     * So the label alone decides — if it asks about skills, the plan owns it — and this branch now
     * RETURNS whatever the plan did. Failing is reported; it never degrades into typing a value at
     * a multi-select taxonomy, which was never going to be right even when the value was real.
     */
    if (/\b(add skills?|^skills?)\b/i.test(field.label)) {
      const filled = await this.fillFromSkillPlan(root, locator, field.key);
      if (!filled) {
        console.log(
          `    ✗ the skills plan filled nothing for "${field.label.slice(0, 40)}" — NOT typing a value ` +
            `into a taxonomy; check the entries in skill.txt against what the prompt offers`,
        );
      }
      return filled;
    }

    if (field.widget === "react-select") return this.fillReactSelect(root, locator, value, field.key, field.label);
    // Workday's styled dropdown: the control IS a <button aria-haspopup="listbox">, so there is no
    // <select> for selectOption() and no input to type into. Clicking it opens a listbox of
    // promptOption rows — exactly what fillReactSelect already drives.
    if (field.widget === "workday-select") {
      const picked = await this.fillReactSelect(root, locator, value, field.key, field.label);
      if (!picked) return false;
      // VERIFY. fillReactSelect reported success while RTX kept answering "The field ... is
      // required and must have a value" — a false success, the one thing this path must never
      // produce. The control is a button whose text IS its value, so read it back.
      await locator.page().waitForTimeout(400);
      const shown = ((await locator.innerText().catch(() => "")) || "").trim();
      const got = normaliseOption(shown);
      // A comma-separated answer means alternatives, so any of them landing counts.
      const wanted = value.split(",").map((v) => normaliseOption(v)).filter(Boolean);
      const ok = got !== "" && wanted.some((w) => got === w || got.includes(w) || w.includes(got));
      if (!ok) {
        console.log(`      ✗ "${field.label.slice(0, 44)}" still reads ${JSON.stringify(shown)} after picking ${JSON.stringify(value.slice(0, 40))} — not reporting that as filled`);
        return false;
      }
      return true;
    }

    if (field.type === "single_select") {
      const options = field.options || [];
      const match = options.find((o) => o.toLowerCase() === value.toLowerCase()) || options.find((o) => o.toLowerCase().includes(value.toLowerCase()));
      if (!match) return false;
      await locator.selectOption({ label: match });
      return true;
    }
    if (field.type === "date") return this.fillDate(locator, value);
    if (field.type === "checkbox") {
      // "No" on a checkbox is a REAL answer, satisfied by leaving the box clear — it is not
      // a failure to fill. Returning false for it put every Workday "I have a preferred
      // name" into the review email's "no answer available" list, even though the answer
      // (No) was known all along, and left the field looking unresolved.
      const wantChecked = /^(yes|true|y|i agree|agree|i acknowledge|check)/i.test(value.trim());
      const current = await locator.isChecked().catch(() => false);
      if (current !== wantChecked) {
        if (wantChecked) await locator.check({ force: true }).catch(() => undefined);
        else await locator.uncheck({ force: true }).catch(() => undefined);
        // Custom checkboxes hide the real input and only update on a click of the visible
        // control, same as the radio handling below.
        if ((await locator.isChecked().catch(() => current)) !== wantChecked) {
          const id = await locator.getAttribute("id").catch(() => null);
          if (id) await root.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first().click().catch(() => undefined);
        }
      }
      return (await locator.isChecked().catch(() => current)) === wantChecked;
    }
    if (field.type === "radio") {
      // Scope to actual radio inputs — a name-based group can also match a hidden
      // mirror <input> (Workday), which would shift nth() off by one. Option order
      // matches radio order, so this index lines up with field.options.
      const group = root.locator(`input[type="radio"]${field.key}`);
      const options = field.options || [];
      const want = value.toLowerCase();
      let idx = options.findIndex((o) => o.toLowerCase() === want);
      if (idx < 0) idx = options.findIndex((o) => o.toLowerCase().includes(want) || want.includes(o.toLowerCase()));
      if (idx < 0) return false;
      const radio = group.nth(idx);
      const page = radio.page();
      const isSet = () => radio.isChecked().catch(() => false);
      await radio.scrollIntoViewIfNeeded().catch(() => undefined);
      // Custom radios (Workday, etc.) hide the real input and update React state
      // only on a click of the VISIBLE control. Try, in order: check(); the <label
      // for>; the wrapping element (input's parent/grandparent); a force click on
      // the input itself. Verify isChecked after each and stop once it sticks.
      await radio.check({ force: true }).catch(() => undefined);
      if (!(await isSet())) {
        const id = await radio.getAttribute("id").catch(() => null);
        if (id) await root.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first().click().catch(() => undefined);
      }
      if (!(await isSet())) {
        await radio.locator("xpath=..").click().catch(() => undefined); // wrapping control
      }
      if (!(await isSet())) {
        await radio.locator("xpath=../..").click().catch(() => undefined); // grandparent wrapper
      }
      if (!(await isSet())) {
        await radio.click({ force: true }).catch(() => undefined);
      }
      await page.waitForTimeout(150);
      return await isSet();
    }
    /**
     * TYPE IT, THEN READ IT BACK. `fill()` used to be followed by an unconditional `return true`
     * with the error swallowed, which is the one thing this path is not allowed to do
     * ("Nothing reports success without verification"). Two failures hid behind it:
     *
     *   - a Workday date part is a TWO-DIGIT spinbutton. Answered "1", it treats the entry as
     *     part-typed and discards it on blur, so Michelin's Start Date kept the resume autofill's
     *     12/2025 while the answer on record said 1/2025 — a wrong date that reads as a chosen one.
     *   - a control `fill()` cannot type into at all threw into the `.catch`, and the caller was
     *     told it worked.
     *
     * An empty read-back after typing something is proof it did not land. A DIFFERENT read-back is
     * not: inputs reformat (a phone mask, a trimmed code), and calling that a failure would retry
     * fields that are already correct. So this refuses only on empty, and says so.
     */
    const wanted = datePartOf(field.label) ? datePartValue(field.label, value) : value;
    await locator.fill(wanted).catch(() => undefined);
    const readBack = async () => ((await locator.inputValue().catch(() => "")) || "").trim();
    if (wanted.trim() && !(await readBack())) {
      // Typing is also what the stealth rule asks for, and a spinbutton takes keystrokes when it
      // will not take a programmatic fill.
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.click().catch(() => undefined);
      await locator.pressSequentially(wanted, { delay: 40 }).catch(() => undefined);
      await locator.page().waitForTimeout(120);
      if (!(await readBack())) {
        console.log(`    [fill] "${field.label.slice(0, 44)}" would not take ${JSON.stringify(wanted)} — still empty`);
        return false;
      }
    }
    return true;
  }

  /** Fill a date field: native <input type=date> takes ISO; a text picker (Ashby)
   *  takes MM/DD/YYYY typed in, then Escape to dismiss the calendar popover. */
  protected async fillDate(locator: Locator, value: string): Promise<boolean> {
    const d = parseDate(value);
    if (!d) return false;
    const page = locator.page();
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${d.y}-${pad(d.m)}-${pad(d.day)}`;
    const us = `${pad(d.m)}/${pad(d.day)}/${d.y}`;
    const inputType = (await locator.getAttribute("type").catch(() => null)) || "";
    if (inputType.toLowerCase() === "date") {
      await locator.fill(iso).catch(() => undefined);
      return true;
    }
    // Text-based date picker (e.g. react-datepicker): type the date, commit with
    // Enter (react-datepicker selects the typed date), then Escape to close.
    const ok = async (): Promise<boolean> => {
      const v = (await locator.inputValue().catch(() => "")) || "";
      return v.replace(/\s/g, "").length >= 6;
    };
    for (const fmt of [us, iso]) {
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.click().catch(() => undefined);
      await page.waitForTimeout(200);
      await locator.fill("").catch(() => undefined);
      await locator.pressSequentially(fmt, { delay: 40 }).catch(() => undefined);
      await page.waitForTimeout(250);
      // A date input takes Enter as "commit the typed date" — on a form with no picker open it is
      // a submit keystroke instead. Blur commits the same value and cannot submit anything.
      await locator.blur().catch(() => undefined);
      await page.waitForTimeout(200);
      if (await ok()) {
        await page.keyboard.press("Escape").catch(() => undefined); // close calendar if still open
        return true;
      }
    }
    return await ok();
  }

  /**
   * Type into a typeahead and commit a real selection.
   *
   * A taxonomy box ("Type to Add Skills" — thousands of entries behind a 14-row first page)
   * will not necessarily filter on the WHOLE answer: typing "Python (Programming Language)"
   * or "C++" can return nothing, while "Pyth" returns the row we want. So the full value is
   * only the first probe; on later attempts it is shortened — first word, then a 4-letter
   * prefix — and every option that appears is matched against the answer. If nothing matches,
   * the options that WERE offered are logged, because a silent "would not take it" is
   * undiagnosable and this field failed that way for five turns.
   */
  /**
   * Tick every entry the curated plan names, one search at a time.
   *
   * Each group is a separate server-side search: type the heading, press Enter (this prompt
   * queries on Enter, not on keystrokes), then click each listed option by its exact
   * data-automation-label. A label the taxonomy no longer offers is REPORTED rather than
   * silently skipped — a curated list going stale is something the user needs to hear about.
   */
  protected async fillFromSkillPlan(root: Root, control: Locator, keySelector: string): Promise<boolean> {
    const picks = await loadSkillPicks();
    if (!picks.length) return false;
    const page = control.page();
    let selected = 0;
    const missing: string[] = [];
    const offeredFor = new Map<string, string[]>();

    const listbox = root.locator('[data-automation-id="activeListContainer"], [role="listbox"]').first();
    const firstLabel = async (): Promise<string> => {
      const rows = await this.scopedOptions(root, keySelector, control);
      if (!(await rows.count().catch(() => 0))) return "";
      return ((await rows.first().getAttribute("data-automation-label").catch(() => null)) || "").trim();
    };

    /** Type a search and wait until the results belong to IT, not to the previous query. */
    const search = async (term: string): Promise<void> => {
      const before = await firstLabel();
      await control.scrollIntoViewIfNeeded().catch(() => undefined);
      await control.click().catch(() => undefined);
      await page.waitForTimeout(200);
      await control.fill("").catch(() => undefined);
      await control.pressSequentially(term, { delay: 15 }).catch(() => undefined);
      /**
       * This prompt queries the server on ENTER, not on keystrokes — but only when its own menu is
       * open. The scoped lookup is what makes that safe to ask: a page-wide check would say "yes"
       * because of some other field's open list, and the keystroke would reach the form instead.
       */
      await this.pressEnterOnWorkdayPrompt(root, control, () => this.scopedOptions(root, keySelector, control));
      for (let wait = 0; wait < 16; wait += 1) {
        await page.waitForTimeout(250);
        const now = await firstLabel();
        if (now && now !== before) return; // the list has answered this query
        if (/no items/i.test(now)) return;
      }
    };

    /** Click one exact label, paging the virtualised list to find it. */
    const choose = async (target: string, offered: Set<string>): Promise<boolean> => {
      const selector = `[data-automation-id="promptOption"][data-automation-label="${target.replace(/"/g, '\\"')}" i]`;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const row = root.locator(selector).first();
        if ((await row.count().catch(() => 0)) > 0) {
          await row.scrollIntoViewIfNeeded().catch(() => undefined);
          await row.click().catch(() => undefined);
          await page.waitForTimeout(220);
          return true;
        }
        const rows = await this.scopedOptions(root, keySelector, control);
        const n = await rows.count().catch(() => 0);
        for (let i = 0; i < n; i += 1) {
          const label = ((await rows.nth(i).getAttribute("data-automation-label").catch(() => null)) || "").trim();
          if (label) offered.add(label);
        }
        const moved = await listbox
          .evaluate((el) => {
            const before = el.scrollTop;
            el.scrollTop = before + Math.max(120, el.clientHeight - 32);
            return el.scrollTop !== before;
          })
          .catch(() => false);
        if (!moved) return false;
        await page.waitForTimeout(200);
      }
      return false;
    };

    let currentSearch = "";
    const offeredBySearch = new Map<string, Set<string>>();
    for (const pick of picks) {
      const offered = offeredBySearch.get(pick.search) ?? new Set<string>();
      offeredBySearch.set(pick.search, offered);
      // Search only when the term changes — consecutive picks that share one term reuse the
      // list, and a pick that names its own term (skill.txt "Node.js | Node") gets it.
      if (pick.search !== currentSearch) {
        await search(pick.search);
        currentSearch = pick.search;
      }
      {
        const target = pick.label;
        // Selecting a row makes Workday re-render the list, which resets the scroll position — so
        // when an entry is not found, run the search again before giving up on it. One search per
        // group plus a retry gets the whole group; a fresh search for every entry does not work at
        // all, because re-opening the prompt that many times stops it returning results.
        let ok = await choose(target, offered);
        if (!ok) {
          // Selecting a row re-renders the list and resets its scroll, so an entry that was below
          // the fold can be missed on the first pass. Search again and look once more.
          await search(pick.search);
          ok = await choose(target, offered);
        }
        if (ok) selected += 1;
        else {
          missing.push(`${pick.search} → ${target}`);
          if (offered.size) offeredFor.set(pick.search, [...offered]);
        }
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);

    if (missing.length) {
      console.log(`      ↳ skill.txt lists ${missing.length} entr${missing.length === 1 ? "y" : "ies"} the taxonomy did not offer:`);
      for (const m of missing.slice(0, 12)) console.log(`         · ${m}`);
      // Say what the taxonomy DID offer for those searches, so a stale line in skill.txt can be
      // corrected against the real vocabulary instead of guessed at.
      for (const [search, labels] of offeredFor) {
        console.log(`         "${search}" offered: ${labels.slice(0, 10).join(" | ")}${labels.length > 10 ? ` (+${labels.length - 10})` : ""}`);
      }
    }
    console.log(`      ↳ selected ${selected} skill(s) from skill.txt`);
    return selected > 0;
  }

  /**
   * Delete skills the resume autofill put on the form that do not belong there.
   *
   * Uploading the resume makes the ATS populate Skills from its own parse of the PDF. It
   * guesses badly — a live Workday application came back listing "Teaching", "Social Media",
   * "Verification", "Quality Assurance (QA)", "Microsoft Office" and "Natural Language"
   * alongside the real ones. None of those are in skill.txt's plan, so nothing in the fill
   * path adds them and nothing in the fill path takes them off either: an autofilled value is
   * already committed, so the field reads as filled and is never offered for filling. Without
   * this pass they go in exactly as the ATS guessed them.
   *
   * Two rules make it safe to run on every turn:
   *
   * - The match is EXACT (trimmed, case-insensitive) against the REMOVE section of skill.txt.
   *   A substring rule would take "Language Processing" out with "Natural Language" and
   *   "Formal Verification" out with "Verification" — both of which are wanted.
   * - It only looks inside a container whose own label asks about skills. A committed pill
   *   elsewhere on the page is somebody else's answer, and deleting one because its text
   *   happened to match would be silent data loss.
   *
   * Returns the labels actually removed — confirmed gone by a re-read, not by the click
   * having been dispatched.
   */
  async pruneSkills(root: Root): Promise<string[]> {
    const removals = await loadSkillRemovals();
    if (!removals.length) return [];

    const MARK = "data-jobapp-prune";
    /**
     * Read every committed pill on the page, with the container that holds it.
     *
     * The page script only OBSERVES — which pills to delete is decided in TypeScript by
     * pillsToRemove, where the rule can be tested (src/debug/skillRemovalCases.ts). A
     * matching rule that only exists inside an evaluate() string cannot be.
     */
    const COLLECT = `(() => {
      const clean = (t) => (t || "").replace(/\\s+/g, " ").trim();
      // The container's LABEL, not its whole text — the text includes the pills.
      const labelOf = (box) => {
        const el = box.querySelector('label, legend, [id$="-label"]');
        return clean((el && el.textContent) || box.getAttribute("aria-label") || "");
      };
      const out = [];
      let n = 0;
      const boxes = Array.from(document.querySelectorAll('[data-automation-id^="formField-"], [data-automation-id*="skill" i], fieldset, [role="group"]'));
      for (const box of boxes) {
        const pills = box.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] li, [class*="multi-value"]');
        for (const pill of Array.from(pills)) {
          const nameEl = pill.querySelector('[data-automation-id="selectedItemName"], [class*="multi-value__label"]');
          const mark = pill.getAttribute("${MARK}") || String(n++);
          pill.setAttribute("${MARK}", mark);
          out.push({
            mark: mark,
            containerId: box.getAttribute("data-automation-id") || "",
            containerLabel: labelOf(box),
            text: clean(nameEl ? nameEl.textContent : pill.textContent),
          });
        }
      }
      return JSON.stringify(out);
    })()`;

    const collect = async (): Promise<SkillPill[]> => {
      try {
        return JSON.parse((await root.evaluate(COLLECT)) as string) as SkillPill[];
      } catch {
        return [];
      }
    };

    const targets = pillsToRemove(await collect(), removals);
    if (!targets.length) return [];

    // The delete affordance has no single stable id across Workday versions and react-select,
    // so try the specific ones before the generic. The bare `button` is last on purpose: the
    // only control inside a committed pill is its own delete.
    const DELETE_SELECTORS = [
      '[data-automation-id="DELETE_charm"]',
      '[data-automation-id*="delete" i]',
      'button[aria-label*="delete" i]',
      'button[aria-label*="remove" i]',
      '[role="button"][aria-label*="delete" i]',
      '[role="button"][aria-label*="remove" i]',
      '[class*="multi-value__remove"]',
      '[class*="wd-icon-close"]',
      "button",
      '[role="button"]',
    ];

    /** Is a pill with this label still committed to a skills container? */
    const stillPresent = async (label: string): Promise<boolean> =>
      pillsToRemove(await collect(), [label]).length > 0;

    const page = "page" in root ? (root as { page(): Page }).page() : (root as Page);
    const removed: string[] = [];
    const stuck: string[] = [];

    for (const target of targets) {
      const pill = root.locator(`[${MARK}="${target.mark}"]`).first();
      if (!(await pill.count().catch(() => 0))) continue;
      let gone = false;
      for (const selector of DELETE_SELECTORS) {
        const control = pill.locator(selector).first();
        if (!(await control.count().catch(() => 0))) continue;
        await control.scrollIntoViewIfNeeded().catch(() => undefined);
        await control.click({ timeout: 4000 }).catch(() => undefined);
        await page.waitForTimeout(250);
        // Verified, not assumed. A click that dispatched but did not delete must never be
        // reported as a removal, or the review claims a skill is gone while it is still on
        // the form and about to be submitted.
        if (!(await stillPresent(target.label))) {
          gone = true;
          break;
        }
      }
      if (gone) removed.push(target.label);
      else stuck.push(target.label);
    }

    // Clear the markers, so a later turn re-finds anything still there rather than treating
    // it as already handled.
    await root
      .evaluate(`(() => { document.querySelectorAll('[${MARK}]').forEach((el) => el.removeAttribute('${MARK}')); return true; })()`)
      .catch(() => undefined);

    if (stuck.length) {
      console.log(`      ↳ could NOT remove ${stuck.length} autofilled skill(s) — still on the form: ${stuck.join(", ")}`);
    }
    return removed;
  }

  protected async fillReactSelect(root: Root, control: Locator, value: string, keySelector?: string, label?: string): Promise<boolean> {
    // "Python, Computer Science" means "the real answer, then a broader one": try each in turn
    // and keep the first the live list actually offers. A taxonomy that lacks the specific term
    // usually has the general one, and an empty skills box helps nobody.
    /**
     * A SLASH also means alternatives, and the whole string is not one of them. The answer store
     * holds "Man/Male" for Gender because forms word it both ways; the list offers "Male", and
     * asking for "Man/Male" matches nothing — measured on Uline, where a required EEO field was
     * abandoned over it.
     *
     * Both parts must be real words: "N/A" is a value, not a choice between "N" and "A".
     */
    const slashed = value.split("/").map((v) => v.trim());
    const alternatives =
      slashed.length > 1 && slashed.every((v) => v.length >= 3)
        ? slashed
        : value.includes(",")
          ? value.split(",").map((v) => v.trim()).filter((v) => v.length >= 2)
          : [];
    if (alternatives.length > 1) {
      for (const candidate of alternatives) {
        if (await this.fillReactSelectOne(root, control, candidate, keySelector, label)) return true;
      }
      return false;
    }
    return this.fillReactSelectOne(root, control, value, keySelector, label);
  }

  /**
   * What a react-select control DISPLAYS as its chosen value, or "" while it holds none.
   *
   * The selected value is not in the input — the input is the SEARCH box and react-select clears it
   * on commit. The value lives in a sibling `select__single-value` node, and the value-container
   * gains `--has-value`. Reading the control's whole text instead would return the placeholder
   * ("Select…") for an empty field.
   */
  /**
   * Press Enter ONLY when a menu is open to swallow it.
   *
   * Enter in a form control with no listbox open SUBMITS THE FORM. On 29 August that sent three
   * applications to The Nuclear Company, three minutes apart, with no approval and no record: the
   * fill reached Greenhouse's EEO dropdowns, spent ninety seconds per field pressing Enter at a
   * menu that never opened, and the page went to "Thank you for applying" while the run reported
   * "No next control — stopping" and the ledger wrote `prefilled_pending_submit`.
   *
   * Nothing else in the system could catch it. SUBMIT_TEXT_BLOCKLIST guards CLICKS, and no click
   * happened; the log said "never clicked" truthfully.
   *
   * The check is the widget's own state — aria-expanded, or options actually on screen. If neither
   * says a menu is open, the keystroke has nowhere to go but the form, and we do not send it.
   */
  /**
   * Press Enter ONLY on a Workday taxonomy prompt, and only when that prompt's own list is there.
   *
   * The keystroke is not a tool this code should reach for. Every other widget can be driven by
   * CLICKING the option, and a click lands on one element: it cannot submit a form by accident.
   * Enter goes to whatever has focus, so on any single-page application form it is one missed
   * condition away from filing the application — which it did, seven times, at The Nuclear Company,
   * Chicago Trading and HP IQ. Two attempts to make it safe with a general guard both left a hole,
   * the second one carrying a confident comment about why it could not.
   *
   * So it is no longer general. One widget genuinely needs it — Workday's prompt runs its search on
   * ENTER rather than on keystrokes, measured live: typing "python" alone leaves the unfiltered
   * A-page, typing it and pressing Enter returns nineteen real rows. That widget identifies itself
   * in the DOM, and this refuses to fire without that identification. On Greenhouse, Ashby, Lever
   * or Workable the answer is always no, whatever the page is doing.
   */
  private async pressEnterOnWorkdayPrompt(
    root: Root,
    control: Locator,
    menu?: () => Promise<Locator>,
  ): Promise<boolean> {
    const isWorkdayPrompt =
      (await control
        .locator(
          'xpath=ancestor::*[@data-automation-id="multiSelectContainer" or @data-automation-id="multiselectInputContainer" or starts-with(@data-automation-id,"promptOption") or starts-with(@data-automation-id,"formField")][1]',
        )
        .count()
        .catch(() => 0)) > 0;
    if (!isWorkdayPrompt) return false;

    // And its own list must be present, so the keystroke has somewhere to go inside the widget.
    const expanded = await control.getAttribute("aria-expanded", { timeout: 500 }).catch(() => null);
    let open = expanded === "true";
    if (!open && menu) open = (await (await menu()).count().catch(() => 0)) > 0;
    if (!open) {
      open =
        (await root
          .locator('[data-automation-id="activeListContainer"]')
          .count()
          .catch(() => 0)) > 0;
    }
    if (!open) return false;
    await control.press("Enter").catch(() => undefined);
    return true;
  }

  private async committedSelection(control: Locator): Promise<string> {
    const shell = control.locator('xpath=ancestor::*[contains(@class,"select__control")][1]');
    if (!(await shell.count().catch(() => 0))) return "";
    const value = shell.locator('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValue__label"]');
    if (!(await value.count().catch(() => 0))) return "";
    return ((await value.first().innerText().catch(() => "")) || "").trim();
  }

  /**
   * The text of the first `n` option rows.
   *
   * EVERY read is bounded, and that is the point. The promptOption lookup is a WORKDAY probe: on
   * any other ATS the inner locator matches nothing and `getAttribute` waits the Playwright default
   * — 30 SECONDS — before the catch turns it into null. Per row. That, not a matching failure, is
   * what burned the 90-second field deadline on Greenhouse's School, Degree, Discipline, Country
   * and End date month: 776 timeouts in a single batch, every one logged as "tried but the field
   * would not take it" about a menu whose options were sitting there, readable, all along.
   *
   * textContent backs up innerText because innerText is the RENDERED text and comes back empty for
   * a row React has just re-rendered.
   */
  /**
   * Take the answer straight off a list that FILTERED as we typed, before any Enter is pressed.
   *
   * A react-select answers the keystrokes themselves, and Enter into a list that has not finished
   * loading closes the menu instead of choosing from it — which is what left Greenhouse's School
   * and Discipline typeaheads empty while the driver went on to page through the unfiltered list
   * looking for "Carnegie Mellon University" among the A's.
   *
   * Guarded on the list having CHANGED from what was on screen before the keystrokes. Workday
   * leaves its previous, unfiltered page up while it re-queries, and picking from that is how
   * "Info" once matched "Accounting"; an unchanged list means "no answer yet", never "not there".
   */
  private async pickFromFilteredMenu(
    menu: () => Promise<Locator>,
    stale: { first: string; count: number },
    want: string,
    page: Page,
    control: Locator,
  ): Promise<boolean> {
    // A list that will not answer without an Enter (Workday's remote-search prompt leaves its
    // previous page up) must not cost the whole poll on every attempt — six unchanged reads is
    // enough to stop asking and let the Enter path run.
    let unchanged = 0;
    for (let round = 0; round < 12; round += 1) {
      await page.waitForTimeout(250);
      const opts = await menu();
      const count = await opts.count().catch(() => 0);
      if (!count) continue;
      const first = ((await opts.first().innerText({ timeout: 1_000 }).catch(() => "")) || "").trim();
      if (/no items|no options/i.test(first)) return false; // a definite answer: nothing matches
      /**
       * Has the list ANSWERED the keystrokes? A changed first row says yes — but so does a changed
       * length, and the length is the only signal when the wanted row was already at the top:
       * Greenhouse's country selector lists "United States +1" first, so filtering to it alone
       * left the first row identical and the guard waited out all twelve rounds on a list that had
       * answered immediately.
       */
      if (stale.first && first === stale.first && count === stale.count) {
        unchanged += 1;
        if (unchanged >= 6) return false;
        continue;
      }
      const texts = await this.readOptionTexts(opts, Math.min(count, 60));
      const idx = indexOfOption(texts, want);
      if (idx < 0) return false; // the list answered and does not hold it — let the retries run
      const chosen = normaliseOption(texts[idx] ?? "");
      await opts.nth(idx).click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      const committed = await this.committedSelection(control);
      /**
       * Verify against the ROW WE CLICKED, not only against the value we wanted. A control displays
       * the option's own wording and sometimes only part of it: picking "United States +1" from
       * Greenhouse's country selector leaves the control reading "+1", which answers "United
       * States" perfectly well and matches it not at all. Comparing to the row keeps the check
       * strict — a click that landed on nothing still fails.
       */
      // Containment against the CLICKED row, not the fuzzy match: we know which row it was, so any
      // part of it showing in the control is proof the click landed there.
      if (committed) return optionMatches(committed, want) || chosen.includes(normaliseOption(committed));
      // No react-select shell to read back (a Workday prompt). A menu that closed on the click is
      // the only other evidence available, and a click that dispatched without selecting must not
      // be reported as filled.
      const after = await menu();
      return (await after.count().catch(() => 0)) === 0;
    }
    return false;
  }

  private async readOptionTexts(locator: Locator, n: number): Promise<string[]> {
    const out: string[] = [];
    if (!n) return out;
    /**
     * Ask ONCE whether this is a Workday list, then stop asking. `data-automation-label` is a
     * Workday-only attribute; probing for it per row costs the full locator timeout on every other
     * ATS, which is 29 seconds on a 72-row Greenhouse menu even with the timeout bounded to 400ms.
     * `count()` does not wait, so the question itself is free.
     */
    const first = locator.first();
    const workday =
      (await first.getAttribute("data-automation-label", { timeout: 1_000 }).catch(() => null)) !== null ||
      (await first.locator('[data-automation-id="promptOption"]').count().catch(() => 0)) > 0;
    for (let i = 0; i < n; i += 1) {
      const row = locator.nth(i);
      // Prefer the option's own label attribute: the row wraps a checkbox, so innerText can pick
      // up decoration, while promptOption carries the exact text Workday matches on.
      const wd = workday
        ? (await row.getAttribute("data-automation-label", { timeout: 1_000 }).catch(() => null)) ||
          (await row
            .locator('[data-automation-id="promptOption"]')
            .first()
            .getAttribute("data-automation-label", { timeout: 400 })
            .catch(() => null))
        : null;
      const label =
        wd ||
        (await row.innerText({ timeout: 1_000 }).catch(() => "")) ||
        (await row.textContent({ timeout: 1_000 }).catch(() => "")) ||
        "";
      out.push(label.replace(/\s+not checked$/i, "").trim());
    }
    return out;
  }

  private async fillReactSelectOne(root: Root, control: Locator, value: string, keySelector?: string, label?: string): Promise<boolean> {
    const page = control.page();
    const want = normaliseOption(value);
    const firstWord = value.trim().split(/[\s,/(]+/)[0] ?? value;
    // The FULL value gets two clean attempts before anything is shortened: a full word is what
    // a taxonomy is most likely to contain, and these menus are flaky enough that one miss
    // proves nothing. Only then try the first word, then a short prefix.
    // The full value is not always what the search wants. "Computer and Information Science"
    // returns nothing typed whole, while "information" returns it — so a distinctive INNER word
    // is tried too, longest first (stop-words excluded). Order: the whole value twice (menus are
    // flaky and one miss proves nothing), then the first word, then the longest inner word, then
    // a short prefix.
    const probes = searchProbes(value);
    let lastSeen: string[] = [];
    let typedInto = "";
    /**
     * One line per attempt when SELECT_TRACE=1. A dropdown that will not take a value looks
     * identical in the log to one whose menu never opened, and the difference decides whether to
     * fix the matching or the opening — diagnosing the Greenhouse commit bug meant reconstructing
     * this by hand in a scratch script.
     */
    const trace = (note: string): void => {
      if (process.env.SELECT_TRACE === "1") console.log(`      · select[${value.slice(0, 24)}] ${note}`);
    };
    // DO NOT add an early-out here for "no option list appeared yet". It was tried (2026-08-21)
    // and it is wrong: bailing after the two open strategies produced nothing broke the country
    // phone code, "United States of America (+1)" — the case longListCases.ts exists for. On a
    // live Workday page that menu often stays empty for the first two attempts and opens on a
    // later one, where the bisect then finds it seventeen pages down. Measured: the guard fired
    // on it eight times in one batch, and none of those ten applications reached Review.
    //
    // longListCases did NOT catch this, which is the lesson worth keeping: it drives one field
    // on a freshly opened page, where the menu opens on the first attempt. Mid-application, with
    // a stray list from the previous field still closing, it does not. A passing case for a
    // field is not evidence about the timing of that field mid-form.
    //
    // The cost this was meant to save is handled by the field deadline instead (30s, turnLoop).
    const menu = () =>
      keySelector
        ? this.scopedOptions(root, keySelector, control)
        : Promise.resolve(root.locator('[class*="select__menu"] [class*="select__option"], [class*="select__menu"] [role="option"]'));

    // React-select menus are flaky to open (portal timing, filter re-render), so
    // retry with two open strategies: type-to-filter, then keyboard ArrowDown.
    // 0 = open and look, 1 = ArrowDown, then one attempt per probe.
    for (let attempt = 0; attempt < 2 + probes.length; attempt += 1) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150);
      // A menu left open by the PREVIOUS field is read as if it were ours: searching "Social
      // Media" for "How did you hear about us?" came back with "Afghanistan (+93), Åland
      // Islands (+358)…" — the country-code list from the field before it. Make sure the page
      // has no open list before opening ours.
      for (let clear = 0; clear < 3; clear += 1) {
        const stray = root.locator('[data-automation-id="activeListContainer"]');
        if (!(await stray.count().catch(() => 0))) break;
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(200);
      }
      await control.scrollIntoViewIfNeeded().catch(() => undefined);
      await control.click().catch(() => undefined);
      await page.waitForTimeout(350);
      // What is on screen before we type? Anything still showing this after the keystrokes is
      // a stale render, not an answer to our query.
      trace(`attempt ${attempt} — clicked`);
      const preOpts = await menu();
      const staleCount = await preOpts.count().catch(() => 0);
      const staleFirst =
        staleCount > 0 ? ((await preOpts.first().innerText({ timeout: 1_000 }).catch(() => "")) || "").trim() : "";
      /**
       * ATTEMPT 0 TYPES NOTHING — open the list and look.
       *
       * The candidate's instruction, and it is right for most of these fields: click the arrow,
       * the whole list appears, pick the row. "How Did You Hear About Us?" has seven options and
       * "Degree" a handful; both were being TYPED at, and both failed, when the answer was on
       * screen the moment the list opened. Typing is for the long lists — countries, taxonomies —
       * where the answer is pages down.
       *
       * It also sidesteps a fault this widget has on some tenants: after the click, focus lands on
       * a <ul> and there is no search input anywhere, so keystrokes go nowhere and every trace line
       * read `typed "Unit" → control shows ""`. A list we do not have to type into cannot fail that
       * way.
       */
      if (attempt === 0) {
        if (await this.pickFromFilteredMenu(menu, { first: staleFirst, count: staleCount }, want, page, control)) return true;
        trace(`attempt 0 — opened without typing; the answer was not in the list as shown`);
      } else if (attempt === 1) {
        await control.press("ArrowDown").catch(() => undefined); // open without filtering
      } else {
        // Clear first. Workday's prompt keeps whatever is in its searchBox between attempts,
        // so a retry appended the text to itself ("Job BoardJob Board"), which matched no
        // option at all and turned a recoverable miss into a permanent failure.
        const probe = probes[Math.min(attempt - 2, probes.length - 1)];
        // Clear ONLY when there is something to clear. `fill("")` on react-select dispatches an
        // input event that CLOSES the menu it just opened, so on the common path — an empty search
        // box — clearing threw away the open list and the attempt could not commit. Workday's
        // prompt is the case this exists for: it keeps the previous text between attempts, so a
        // retry typed "Job BoardJob Board".
        if (((await control.inputValue().catch(() => "")) || "").length > 0) {
          await control.fill("").catch(() => undefined);
        }
        await control.pressSequentially(probe, { delay: 20 }).catch(() => undefined);
        // Did the text actually land in the box the page filters on? A Workday prompt kept
        // offering the same alphabetical first page — Accounting, Actuarial Science … — no
        // matter what we typed, because the node we type into is not always the search box it
        // listens to. Typing through the KEYBOARD reaches whatever the click focused.
        typedInto = await control.inputValue().catch(() => "");
        if (typedInto.trim().toLowerCase() !== probe.trim().toLowerCase()) {
          await page.keyboard.type(probe, { delay: 20 }).catch(() => undefined);
          await page.waitForTimeout(250);
          typedInto = (await control.inputValue().catch(() => "")) || `(keyboard: ${probe})`;
        }
        // Look before pressing anything: a react-select has already filtered, and Enter into a
        // half-loaded list closes the menu rather than choosing from it.
        if (await this.pickFromFilteredMenu(menu, { first: staleFirst, count: staleCount }, want, page, control)) return true;
        // A Workday prompt backed by a REMOTE search (its rows come back as
        // "menuItem-REMOTE_SKILL-1-119486") does not query on keystrokes — it queries on ENTER.
        // Without it the list keeps showing the pre-search page, which is why every probe from
        // "Python" to "JavaScript" was matched against the same fourteen A-entries. Typing
        // "python" then Enter returns nineteen real rows: Python (Programming Language),
        // Python IDLE, Pandas Python Library, and so on.
        await this.pressEnterOnWorkdayPrompt(root, control, menu);
        await page.waitForTimeout(400);
        /**
         * TYPE-AND-ENTER IS A COMPLETE SELECTION on react-select — check before doing anything
         * else. Greenhouse's newer forms (job-boards.greenhouse.io) commit right here: typing
         * filters the list to one row and Enter takes it. The code then went looking for an OPEN
         * menu, found none because the menu had CLOSED on commit, read that as "the menu never
         * opened", and retried the whole sequence for every remaining probe — 90 seconds per
         * field, ending in "tried but the field would not take it" about a field that was
         * correctly filled on the first attempt. 776 of those in one batch, on School, Degree,
         * Discipline, Country and End date month.
         *
         * It also stops the SECOND Enter below from ever reaching a form with no menu open, where
         * it is a submit keystroke rather than a search one.
         */
        const committedNow = await this.committedSelection(control);
        trace(`typed ${JSON.stringify(typedInto)} → control shows ${JSON.stringify(committedNow)}`);
        if (committedNow && optionMatches(committedNow, want)) return true;
        // Workday's taxonomy prompts do NOT filter as you type — they run the search on
        // ENTER. Without this the list never changed, so every probe read back the same
        // unfiltered first page (Accounting | Actuarial Science | Advertising …) and the
        // field was abandoned as "would not take it" — measured on Pentair for both Field
        // of Study and Skills. Typing "information" then Enter is what surfaces "Computer
        // and Information Science" / "Information Technology" / "Management Information
        // Systems"; typing "python" then Enter surfaces the python skills.
        /**
         * A keyboard Enter goes wherever focus is, which on a page with no menu open is the form.
         * Workday's remote-search prompt is the only widget that needs it, and it can be asked
         * whether it is listening: if no menu is open, this keystroke would be a submit.
         */
        await this.pressEnterOnWorkdayPrompt(root, control, menu);
        await page.waitForTimeout(400);
      }
      // Async option lists (Greenhouse's school/discipline typeahead re-fetches per
      // keystroke and renders "Loading..." before any option) resolve after a variable
      // delay, so poll for real options instead of sampling once at a fixed wait.
      // Re-resolve menu() each round: aria-controls only exists while the menu is open.
      //
      // "Non-empty" is NOT the same as "answering our query". Workday leaves the previous
      // render on screen while it re-queries, so the first non-empty read can be the stale
      // unfiltered first page — measured: typing "Info" returned Accounting / Actuarial
      // Science / Advertising, the same A-page as before the keystrokes, while "Pyth" on the
      // same field correctly returned "No Items.". Accepting the stale page is what made the
      // match fail. So wait for the list to CHANGE from what was showing before we typed.
      let opts = await menu();
      let count = 0;
      let prevFirst = "";
      let stableFor = 0;
      // A list that does not filter (Workday's country codes are static and alphabetical) makes
      // every remaining typing probe pointless: they all return the same first page, at five
      // seconds a go. One unchanged read is enough to know, and the bisect below does the work.
      let staticList = false;
      // Did we WATCH this list change in response to the keystrokes? Only then is what it renders
      // a complete answer for the query. Not the same as !staticList: a menu that opens empty and
      // fills in tells us nothing either way, and must keep the old behaviour.
      let filtered = false;
      for (let wait = 0; wait < 20; wait += 1) {
        await page.waitForTimeout(250);
        opts = await menu();
        count = await opts.count().catch(() => 0);
        if (count === 0) {
          prevFirst = "";
          continue;
        }
        const firstNow = ((await opts.first().innerText().catch(() => "")) || "").trim();
        if (/no items/i.test(firstNow)) break; // a definite answer: the query matched nothing
        // The list changed away from what was showing before the keystrokes → it has answered.
        if (staleFirst && firstNow !== staleFirst) {
          filtered = true;
          break;
        }
        // Nothing to compare against (the menu opened empty and filled in as we typed), so
        // require the list to hold still: two identical reads in a row. Taking the first
        // non-empty render here is what matched "Info" against the unfiltered A-page.
        stableFor = firstNow === prevFirst ? stableFor + 1 : 0;
        prevFirst = firstNow;
        if (!staleFirst && stableFor >= 2) break;
        if (staleFirst && firstNow === staleFirst && stableFor >= 2) {
          staticList = true;
          break;
        }
      }
      if (count === 0) {
        // A closed menu is not always a failure to open: it is also what a COMMITTED selection
        // looks like (ArrowDown then Enter, or a click that landed). Ask the control what it
        // holds before spending another attempt on it.
        const settled = await this.committedSelection(control);
        trace(`no options in menu; control shows ${JSON.stringify(settled)}`);
        if (settled && optionMatches(settled, want)) return true;
        continue; // menu didn't open — retry
      }

      const readTexts = (locator: Locator, n: number) => this.readOptionTexts(locator, n);
      let texts = await readTexts(opts, count);
      lastSeen = texts;
      trace(`${count} option(s): ${texts.slice(0, 4).join(" | ")}`);
      const lead = (t: string) => normaliseOption(t).split(/[,(:—–-]/)[0].trim();
      // Workday's skill search returns the taxonomy's canonical entries AND a free-text row for
      // whatever was typed — searching "python" yields both "Python (Programming Language)" and
      // a bare "python". Prefer the canonical one: it is the entry a recruiter's search matches,
      // where the free-text row is just the raw string we typed.
      // A phone country code arrives as "+1" while the options read "United States of America
      // (+1)". Match on the parenthesised code, preferring the United States when several
      // countries share it (+1 covers Canada, American Samoa, Guam…).
      /**
       * THE LIST MAY BE A CHOOSER, AND THE REAL OPTIONS ARE ONE LEVEL DOWN.
       *
       * Intel's "Education — Field of Study*" opens on "Partial List (First 500 Entries)" and
       * "All" — neither is a field of study — so every probe reported no match and a REQUIRED
       * field stayed empty. RTX does the same, which is why CLAUDE.md has carried this case as
       * "not yet handled" since August.
       *
       * Click through, re-read, and carry on matching against the real entries. listChooserRow
       * decides, and it requires EVERY row to be list navigation: "All" beside "United States"
       * is a real answer, and clicking through that would discard the options we came for.
       */
      const chooser = listChooserRow(texts);
      if (chooser) {
        const row = opts.filter({ hasText: chooser }).first();
        const target = (await row.count().catch(() => 0)) > 0 ? row : opts.nth(texts.indexOf(chooser));
        trace(`the list is a chooser (${texts.map((t) => JSON.stringify(t)).join(" | ")}) — opening ${JSON.stringify(chooser)}`);
        await target.click().catch(() => undefined);
        await page.waitForTimeout(700);
        const reread = await readTexts(opts, await opts.count().catch(() => 0));
        if (reread.length && !listChooserRow(reread)) {
          texts = reread;
          lastSeen = texts;
          trace(`${texts.length} real option(s) behind the chooser: ${texts.slice(0, 4).join(" | ")}`);
        } else {
          trace(`the chooser did not open a list of answers — still ${JSON.stringify(reread.slice(0, 3))}`);
        }
      }

      let idx = indexOfOption(texts, want);
      /**
       * "How did you hear about us?" IS A TREE, AND CHASING LINKEDIN DOWN IT IS THE WRONG GOAL.
       *
       * Michelin's prompt opens on tier one — Campus Campaign | Career Websites | Employee
       * Referral | Job Board | Other | Social Media — and LinkedIn sits INSIDE Social Media behind
       * a right arrow. So the recorded answer "LinkedIn" matched nothing, the fill scrolled a list
       * that cannot scroll ("the wheel does not move this list — cannot reach LinkedIn"), typed
       * into it, and left the REQUIRED field empty: an application blocked one field short of
       * Review over a channel nobody cares about.
       *
       * The candidate's rule is explicit — campus first, and "Career Websites should be fine as
       * well" — and Career Websites is sitting right there in tier one. The same preference
       * already existed for Workday's own select path; this control is driven by the react-select
       * path, which never had it and never had the label to test for it either.
       *
       * Only when the wanted value genuinely is not on offer, and only for this question. The
       * clicked row is what the commit is verified against, so picking a different option than we
       * came in with is still verified rather than assumed.
       */
      if (idx < 0 && label && /how did you (hear|find|learn)/i.test(label)) {
        const offered = texts.filter((t) => t && !/^select one$|^no items/i.test(t));
        const preferred = preferredHearAboutUs(offered);
        const at = preferred
          ? texts.findIndex((t) => t.trim().toLowerCase() === preferred.option.trim().toLowerCase())
          : -1;
        if (at >= 0) {
          idx = at;
          trace(`${JSON.stringify(value)} is not offered at this tier; taking ${JSON.stringify(preferred!.option)} (${preferred!.why})`);
        }
      }
      if (idx < 0) {
        // ReactVirtualized renders only the rows in view. Scroll the listbox and re-read before
        // concluding the value is absent.
        const listbox = root.locator('[data-automation-id="activeListContainer"], [role="listbox"]').first();

        // Some of these lists do not filter at all — the country dialling codes are a static,
        // ALPHABETICAL list of ~250 entries shown fourteen at a time, so "United States of
        // America (+1)" sits some seventeen pages below "Afghanistan (+93)" and paging a few
        // screens never reaches it. Sorted list, known target: bisect on the scroll position.
        const ordered = texts.length > 3 && texts[0].localeCompare(texts[texts.length - 1], undefined, { sensitivity: "base" }) < 0;
        /**
         * Only bisect a list that did NOT answer the keystrokes. That is what the bisect is for —
         * Workday's dialling codes are static and virtualised, so the target really is seventeen
         * pages below what is rendered. A list that FILTERED has already told us everything it
         * holds for this query, and scrolling a one-row result finds nothing; on Greenhouse that
         * search cost most of the 90-second deadline per field before the next probe could run.
         *
         * The test is "we watched it change", not "it is not static": a menu that opens empty and
         * fills in has told us nothing, and that case must keep bisecting — an early-out here on
         * weaker evidence is what broke the country phone code once already.
         */
        if (ordered && !filtered) {
          /**
           * Scroll the list and read what is rendered, in one step.
           *
           * The scrollable element is not always the one carrying the listbox role: Workday nests
           * a ReactVirtualized grid inside it. Resolving the wrong element gave a scroll height of
           * zero, so the bisect exited immediately and every read stayed on the A's — which is
           * exactly what the live log showed. Find the element that actually overflows.
           */
          const view = async (top?: number) =>
            (await page
              .evaluate((wanted) => {
                const menu = document.querySelector('[data-automation-id="activeListContainer"], [role="listbox"]');
                if (!menu) return null;
                const scrollers = [menu, ...Array.from(menu.querySelectorAll("*"))].filter(
                  (el) => el.scrollHeight > el.clientHeight + 4,
                );
                const scroller = (scrollers[0] as HTMLElement) ?? (menu as HTMLElement);
                if (typeof wanted === "number") scroller.scrollTop = wanted;
                const labels = Array.from(
                  menu.querySelectorAll('[data-automation-id="promptOption"], [role="option"]'),
                ).map((n) => (n.getAttribute("data-automation-label") || n.textContent || "").replace(/\s+/g, " ").trim());
                return { max: scroller.scrollHeight - scroller.clientHeight, height: scroller.clientHeight, labels };
              }, top)
              .catch(() => null)) as { max: number; height: number; labels: string[] } | null;

          const start = await view();
          let lo = 0;
          let hi = start?.max ?? 0;
          for (let step = 0; step < 16 && idx < 0 && hi > lo; step += 1) {
            const mid = Math.floor((lo + hi) / 2);
            const shown = await view(mid);
            await page.waitForTimeout(180);
            const after = await view();
            const hereTexts = (after?.labels ?? shown?.labels ?? []).filter(Boolean);
            if (!hereTexts.length) break;
            for (const t of hereTexts) if (!texts.includes(t)) texts.push(t);
            lastSeen = texts;
            let hit = hereTexts.findIndex((t) => t.toLowerCase() === want);
            if (hit < 0) hit = hereTexts.findIndex((t) => lead(t) === want);
            if (hit < 0 && /^\+\d{1,4}$/.test(want)) hit = hereTexts.findIndex((t) => t.includes(`(${want})`));
            if (hit >= 0) {
              // Click by its own label rather than by index: the window re-renders as it scrolls.
              const row = root
                .locator(`[data-automation-id="promptOption"][data-automation-label="${hereTexts[hit].replace(/"/g, '\\"')}" i]`)
                .first();
              if ((await row.count().catch(() => 0)) > 0) {
                await row.click().catch(() => undefined);
                await page.waitForTimeout(300);
                if (await this.committedIsWanted(root, keySelector, control, want, normaliseOption(hereTexts[hit]))) return true;
              }
              opts = await menu();
              idx = hit;
              break;
            }
            if (hereTexts[0].localeCompare(value.trim(), undefined, { sensitivity: "base" }) < 0) {
              lo = mid + Math.max(32, (after?.height ?? 200) / 2);
            } else {
              hi = mid - Math.max(32, (after?.height ?? 200) / 2);
            }
          }
        }

        // If nothing reports overflow there is nothing to set scrollTop on, and the bisect above
        // is a no-op — which is what happened live while the fixture passed. The mouse wheel does
        // not care which element scrolls: hover the list and page down. The list is alphabetical,
        // so stop as soon as the rows have gone PAST the target.
        if (idx < 0) {
          // Hover an actual option row, not the listbox wrapper: a wrapper can have no size (or
          // not be the thing that scrolls), and a wheel event delivered there moves nothing.
          const firstRow = (await menu()).first();
          const box = (await firstRow.boundingBox().catch(() => null)) ?? (await listbox.boundingBox().catch(() => null));
          if (box) {
            let movedEver = false;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
            for (let paged = 0; paged < 40 && idx < 0; paged += 1) {
              const here = await menu();
              const n = await here.count().catch(() => 0);
              const hereTexts = await readTexts(here, n);
              for (const t of hereTexts) if (!texts.includes(t)) texts.push(t);
              lastSeen = texts;
              let hit = hereTexts.findIndex((t) => t.toLowerCase() === want);
              if (hit < 0) hit = hereTexts.findIndex((t) => lead(t) === want);
              if (hit < 0) {
                // A value carrying a dialling code — "United States of America (+1)" — should match
                // whichever row holds that code, preferring the United States where several share it.
                const code = value.match(/\((\+\d{1,4})\)/)?.[1] ?? (/^\+\d{1,4}$/.test(want) ? want : "");
                if (code) {
                  const withCode = hereTexts.map((t, i) => ({ t, i })).filter(({ t }) => t.includes(`(${code})`));
                  const us = withCode.find(({ t }) => /united states/i.test(t));
                  if (us) hit = us.i;
                }
              }
              if (hit >= 0) {
                const row = root
                  .locator(`[data-automation-id="promptOption"][data-automation-label="${hereTexts[hit].replace(/"/g, '\\"')}" i]`)
                  .first();
                if ((await row.count().catch(() => 0)) > 0) {
                  await row.click().catch(() => undefined);
                  await page.waitForTimeout(300);
                  if (await this.hasSelection(root, keySelector, control)) return true;
                }
                opts = here;
                idx = hit;
                break;
              }
              if (hereTexts.length && hereTexts[0].localeCompare(value.trim(), undefined, { sensitivity: "base" }) > 0) break;
              const before = hereTexts[0] ?? "";
              await page.mouse.wheel(0, 260).catch(() => undefined);
              await page.waitForTimeout(170);
              const afterFirst = ((await (await menu()).first().getAttribute("data-automation-label").catch(() => null)) || "").trim();
              if (afterFirst && afterFirst !== before) movedEver = true;
              else if (!movedEver && paged >= 2) {
                console.log(`      ↳ the wheel does not move this list (still at "${before}") — cannot reach "${value}"`);
                break;
              }
            }
          }
        }

        for (let scroll = 0; scroll < 4 && idx < 0; scroll += 1) {
          const moved = await listbox
            .evaluate((el) => {
              const before = el.scrollTop;
              el.scrollTop = before + el.clientHeight;
              return el.scrollTop !== before;
            })
            .catch(() => false);
          if (!moved) break;
          await page.waitForTimeout(250);
          const more = await menu();
          const n = await more.count().catch(() => 0);
          const moreTexts = await readTexts(more, n);
          for (const t of moreTexts) if (!texts.includes(t)) texts.push(t);
          lastSeen = texts;
          idx = moreTexts.findIndex((t) => t.toLowerCase() === want);
          if (idx < 0) idx = moreTexts.findIndex((t) => lead(t) === want);
          if (idx < 0) idx = moreTexts.findIndex((t) => t.toLowerCase().includes(want));
          if (idx >= 0) {
            opts = more;
            texts = moreTexts;
            break;
          }
        }
      }
      if (idx < 0 && staticList && attempt === 0) {
        console.log(`      ↳ this list does not filter as you type — searching it by position instead`);
      }
      if (idx < 0) {
        console.log(
          `      ↳ probe "${typedInto || "(arrow-down)"}" → ${texts.length} option(s): ${texts
            .slice(0, 5)
            .join(" | ")}${texts.length > 5 ? ` (+${texts.length - 5})` : ""} — no match for "${value}"`,
        );
        await page.keyboard.press("Escape").catch(() => undefined);
        continue; // options present but no match on this render — retry
      }
      // Click the option by its own TEXT, not by index: Workday nests several nodes per
      // option, so an index taken from the text list can land on a sibling that does nothing.
      const byText = opts.filter({ hasText: texts[idx] }).first();
      const target = (await byText.count().catch(() => 0)) > 0 ? byText : opts.nth(idx);
      const chosenRow = normaliseOption(texts[idx] ?? "");
      await target.click().catch(() => undefined);
      await page.waitForTimeout(350);
      /**
       * Confirm a real SELECTION exists, AND that it is the one we asked for. A Workday prompt
       * shows the typed string while still reporting the field empty, so a click that failed to
       * commit used to be reported as success. And "something is selected" is not enough on its
       * own: measured on Greenhouse's Discipline list, asking for "Information Science" — which
       * that taxonomy does not contain — committed "Computer Science" and returned true. A value
       * the candidate never gave, reported as filled, is the worst outcome this path can produce.
       */
      if (await this.committedIsWanted(root, keySelector, control, want, chosenRow)) return true;
      // Keyboard commit. Verified on a live Workday prompt: clicking the visible row can
      // leave "0 items selected", while ArrowDown + Enter commits ("1 item selected").
      await control.press("ArrowDown").catch(() => undefined);
      await page.waitForTimeout(300);
      await this.pressEnterOnWorkdayPrompt(root, control, menu);
      await page.waitForTimeout(600);
      if (await this.committedIsWanted(root, keySelector, control, want, chosenRow)) return true;
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    // Nothing worked. Print the widget's actual structure once, rather than guessing again at
    // which node to type into and which list to read: every probe returning the SAME unfiltered
    // page means we are talking to the wrong element, and only the DOM can say which is right.
    if (keySelector) {
      const shape = await root
        .locator(keySelector)
        .evaluate((el) => {
          const box = el.closest('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"], [data-automation-id^="formField"]') || el.parentElement;
          const describe = (n: Element) =>
            `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}` +
            `${n.getAttribute("data-automation-id") ? "[aid=" + n.getAttribute("data-automation-id") + "]" : ""}` +
            `${n.getAttribute("role") ? "[role=" + n.getAttribute("role") + "]" : ""}` +
            `${n.getAttribute("aria-controls") ? "[controls=" + n.getAttribute("aria-controls") + "]" : ""}` +
            `${n.getAttribute("aria-expanded") ? "[expanded=" + n.getAttribute("aria-expanded") + "]" : ""}` +
            `${(n as HTMLInputElement).value ? "[value=" + String((n as HTMLInputElement).value).slice(0, 20) + "]" : ""}`;
          const inputs = box ? [...box.querySelectorAll("input, [role=textbox], [contenteditable=true]")].map(describe) : [];
          const listsInside = box ? box.querySelectorAll('[data-automation-id="promptOption"], [role="option"]').length : 0;
          const listsPage = document.querySelectorAll('[data-automation-id="promptOption"], [role="option"]').length;
          const containers = [...document.querySelectorAll('[data-automation-id="activeListContainer"], [role="listbox"]')].map(describe);
          return JSON.stringify({ me: describe(el), box: box ? describe(box) : null, inputs, listsInside, listsPage, containers });
        })
        .catch(() => "");
      if (shape) console.log(`      ↳ widget shape: ${shape}`);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    console.log(
      `      ↳ "${value}" matched none of the offered options [search box held: "${typedInto}"]${
        lastSeen.length ? ` — saw: ${lastSeen.slice(0, 8).join(" | ")}${lastSeen.length > 8 ? ` (+${lastSeen.length - 8})` : ""}` : " — the menu never opened"
      }`,
    );
    return false;
  }

  /** Does this combobox hold a committed value (a react-select value or a Workday pill)? */
  /**
   * A selection exists AND it is the one we meant.
   *
   * When the control displays its value (react-select), that text is checked against the value we
   * wanted or the row we clicked — "United States +1" may show as "+1", which the clicked row
   * accounts for. When there is nothing to read back (a Workday prompt commits into chips), fall
   * back to `hasSelection`, which is all the evidence that widget offers.
   */
  private async committedIsWanted(
    root: Root,
    keySelector: string | undefined,
    control: Locator,
    want: string,
    chosenRow: string,
  ): Promise<boolean> {
    const shown = await this.committedSelection(control);
    if (shown) {
      const got = normaliseOption(shown);
      return optionMatches(shown, want) || (chosenRow !== "" && chosenRow.includes(got));
    }
    return this.hasSelection(root, keySelector, control);
  }

  protected async hasSelection(root: Root, keySelector: string | undefined, control: Locator): Promise<boolean> {
    if (keySelector) {
      const shell = root
        .locator(keySelector)
        .locator(
          'xpath=ancestor-or-self::*[contains(@class,"select__control") or contains(@class,"select__container") or contains(@class,"select-shell") or @data-automation-id="formField" or starts-with(@data-automation-id,"formField")][1]',
        );
      const marker = shell.locator(
        '[class*="single-value"], [class*="multi-value"], [data-automation-id="selectedItem"], [data-automation-id*="pill" i], [data-automation-id="selectedItemList"] li',
      );
      if ((await marker.count().catch(() => 0)) > 0) return true;
    }
    // Deliberately NOT falling back to "the input has text in it". That is precisely the
    // failure state on a Workday prompt: the box reads "LinkedIn" while Workday still
    // reports the field required and empty, and accepting it produced a checkmark for a
    // field that was never set. No selection marker → report failure and let the gate act.
    return false;
  }

  /**
   * Attach the resume. Returns true only when a file was actually set.
   *
   * Called once per run by the turn loop — it used to run EVERY turn, which on Workday
   * attached the resume again on each pass and left five copies on one application, each
   * autofill adding another set of work-experience blocks.
   *
   * Also skips when the page already shows an attachment, so a resumed or re-entered flow
   * does not add a second copy.
   */
  /**
   * Attach EVERY document the form asks for, matched to the right upload.
   *
   * This used to set `input[type="file"]`.first() to the resume and stop. On a form with two
   * uploads — resume and transcript — that put the resume into whichever came first and left the
   * transcript blank, and since read() excludes file inputs, nothing downstream could see the gap:
   * the application reached review with a required transcript missing and no complaint anywhere.
   * (Transcript support did exist, but only in src/adapters/, a tree nothing in the production
   * path imports.)
   *
   * Each input is matched by what the form CALLS it, not by position.
   */
  async uploadDocuments(root: Root, resumePath: string): Promise<DocumentUploads> {
    const out: DocumentUploads = { attached: [], missing: [] };
    const inputs = root.locator('input[type="file"]');
    if ((await inputs.count().catch(() => 0)) === 0) return out;

    /**
     * Describe every upload in ONE round trip, before touching any of them.
     *
     * Greenhouse REMOVES a file input from the DOM the moment it accepts a file, so the list
     * shifts underneath a per-index loop: attaching the resume made input 1 become input 0, and
     * the next `inputs.nth(i).evaluate` waited thirty seconds on a node that no longer existed.
     * Reading the whole list first, then re-locating each one by id, is immune to that.
     */
    const specs = (await inputs
      .evaluateAll((els) =>
        els.map((el, index) => {
          const bits = [
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("name") ?? "",
            el.getAttribute("data-testid") ?? "",
            el.id ?? "",
          ];
          if (el.id) {
            const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lab) bits.push((lab as HTMLElement).innerText ?? "");
          }
          /**
           * CLIMB for the question. `closest("div")` stops at the innermost div, which around an
           * upload button reads "Attach Attach" and names nothing — measured on Appian, where
           * "Please upload a copy of an unofficial undergraduate transcript.*" sits FIVE levels up
           * on div.file-upload, so the transcript input looked unlabelled and was skipped while the
           * form marked it required.
           *
           * The cap is what keeps this honest: stop before the ancestor that holds the WHOLE form,
           * or every upload would see every other upload's question and the resume input would
           * happily claim to want a transcript.
           */
          let box: Element | null = el.parentElement;
          let described = "";
          for (let up = 0; up < 8 && box; up += 1) {
            /**
             * STOP at the first ancestor that holds a SECOND upload. A container with two file
             * inputs cannot describe either of them, and climbing past it is how the resume input
             * came to read the transcript question and take the transcript file.
             */
            if (box.querySelectorAll('input[type="file"]').length > 1) break;
            const text = ((box as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
            if (text.length > 600) break; // prose this long is the form, not the field
            if (text.length > described.length) described = text;
            box = box.parentElement;
          }
          if (described) bits.push(described.slice(0, 600));
          const joined = bits.join(" ");
          return {
            index,
            id: el.id ?? "",
            described: joined.toLowerCase(),
            /** The question as printed, for saying WHICH upload was not filled. */
            question: described.slice(0, 120),
            /** The red star. A form that marks an upload required means it. */
            required: /\*|\brequired\b/i.test(described),
            hasFile: ((el as HTMLInputElement).files?.length ?? 0) > 0,
          };
        }),
      )
      .catch(() => [])) as Array<{
      index: number;
      id: string;
      described: string;
      question: string;
      required: boolean;
      hasFile: boolean;
    }>;

    for (const spec of specs) {
      if (spec.hasFile) continue; // already holds a file — leave it alone

      const wantsTranscript = /transcript|academic record|grade report|marksheet|mark sheet/.test(spec.described);
      const wantsResume = /resume|cv\b|curriculum/.test(spec.described);
      /**
       * A GRADUATE transcript is not a transcript we have.
       *
       * Verkada asks twice — "any unofficial undergraduate transcripts (BS)" and "any graduate
       * transcript (MS, PhD)" — and both match /transcript/, so the same undergraduate record went
       * into both. Filing it under "graduate (MS, PhD)" is not a duplicate, it is a FALSE claim about
       * a degree the candidate does not hold, and worse than leaving an optional field blank.
       *
       * There is exactly one transcript on file and it is the undergraduate record, so nothing can
       * satisfy this field. Said out loud rather than skipped silently, in case a form ever makes it
       * required — that would need a decision, not a guess.
       */
      const wantsGraduateOnly =
        wantsTranscript &&
        /\b(graduate|master'?s?|ms|m\.s|phd|ph\.d|doctoral)\b/i.test(spec.described) &&
        !/\bundergraduate|\bbachelor|\bbs\b|\bb\.s/i.test(spec.described);
      if (wantsGraduateOnly) {
        const why = `${spec.question || "a graduate transcript"} — asks for a GRADUATE transcript; the only one on file is the undergraduate record`;
        if (spec.required) out.missing.push(why);
        console.log(`    – skipped: ${why.slice(0, 92)}`);
        continue;
      }
      /**
       * And one transcript per application. The duplicate guard below covers an UNLABELLED input;
       * two inputs that both name a transcript walked straight past it.
       */
      if (wantsTranscript && out.attached.includes("transcript")) {
        console.log(`    – skipped: a transcript is already attached (${spec.question.slice(0, 60)})`);
        continue;
      }
      const target = wantsTranscript ? TRANSCRIPT_PATH : resumePath;
      const kind = wantsTranscript ? "transcript" : "resume";

      /**
       * An upload we cannot name gets the resume only if the resume is not in already — otherwise a
       * second anonymous upload gets a duplicate copy of the CV.
       *
       * But SKIPPING IT SILENTLY is how two applications reached "ready for review" with a required
       * transcript missing and the red star still on the label. If the form marks it required, say
       * so: the required-field gate and the review page both read `missing`, and neither can act on
       * a document nobody mentioned.
       */
      if (!wantsTranscript && !wantsResume && out.attached.includes("resume")) {
        if (spec.required) {
          out.missing.push(`${spec.question || "an upload"} — required, and no file here matches it`);
          console.log(`    ✗ required upload not recognised: ${spec.question.slice(0, 70)}`);
        }
        continue;
      }

      if (wantsTranscript && !fs.existsSync(TRANSCRIPT_PATH)) {
        out.missing.push(`transcript (the form asks for one and ${path.basename(TRANSCRIPT_PATH)} is not present)`);
        continue;
      }

      const input = spec.id
        ? root.locator(`input[type="file"][id="${spec.id.replace(/"/g, '\\"')}"]`).first()
        : inputs.nth(spec.index);
      // Was the name already on the page? Then its presence afterwards proves nothing about THIS
      // attach — a re-entered flow shows the previous one.
      const shownBefore = await this.showsFileName(root, path.basename(target));
      let failure = "";
      await input.setInputFiles(target, { timeout: 20_000 }).catch((error: Error) => {
        failure = error.message.split("\n")[0];
      });

      /**
       * Verify by what the FORM shows, not only by files.length.
       *
       * Greenhouse takes the file and then removes the input, so reading files.length back gives 0
       * on a detached node — indistinguishable from a refusal. 130 log lines said "setInputFiles
       * did not take" about uploads that had worked, and the required-document gate then blocked
       * finished applications over a resume that was already attached. The filename appearing on
       * the page is the form's own confirmation, and it is the same evidence a person would use.
       */
      const landed = (await input
        .evaluate((el) => (el as HTMLInputElement).files?.length ?? 0, undefined, { timeout: 2_000 })
        .catch(() => -1)) as number;
      const named = !shownBefore && (await this.showsFileName(root, path.basename(target)));
      if (landed > 0 || named) {
        out.attached.push(kind);
        console.log(`    ✓ ${kind} attached${landed > 0 ? "" : " (the form is showing the file)"}`);
      } else {
        const why = failure || "setInputFiles did not take";
        out.missing.push(spec.required ? `${kind} — REQUIRED and not attached (${why})` : `${kind} (${why})`);
        console.log(`    ✗ ${kind} would not attach${failure ? ` — ${failure}` : ""}`);
      }
    }
    return out;
  }

  /** Is the form displaying this filename? That is its own confirmation of an upload. */
  private async showsFileName(root: Root, fileName: string): Promise<boolean> {
    const text = ((await root
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "")) || "").toLowerCase();
    if (!text) return false;
    const base = fileName.toLowerCase();
    // Some forms drop the extension, others rewrite spaces — match on the stem.
    const stem = base.replace(/\.[a-z0-9]+$/, "");
    return text.includes(base) || (stem.length > 8 && text.includes(stem));
  }

  protected async hasSubmit(root: Root): Promise<boolean> {
    return (await root.getByRole("button", { name: SUBMIT }).count().catch(() => 0)) > 0;
  }

  protected async hasNext(root: Root): Promise<boolean> {
    return (await root.getByRole("button", { name: NEXT }).count().catch(() => 0)) > 0;
  }

  /** Click an Apply button/link to open the form (used by openApplication). Safe: never clicks submit. */
  protected async clickApply(page: Page): Promise<boolean> {
    await page.getByRole("button", { name: /accept all|accept cookies|got it/i }).first().click({ timeout: 3000 }).catch(() => undefined);
    const apply = page.getByRole("button", { name: APPLY }).or(page.getByRole("link", { name: APPLY })).first();
    if (await apply.isVisible().catch(() => false)) {
      await apply.click().catch(() => undefined);
      await page.waitForTimeout(3000);
      return true;
    }
    return false;
  }

  /** Click a next/continue control that is NOT a submit. */
  protected async clickNext(root: Root): Promise<boolean> {
    const buttons = root.getByRole("button", { name: NEXT });
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      const text = ((await button.innerText().catch(() => "")) || "").toLowerCase();
      if (SUBMIT.test(text)) continue;
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => undefined);
        return true;
      }
    }
    return false;
  }
}
