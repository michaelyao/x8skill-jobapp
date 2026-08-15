import type { Locator, Page } from "playwright";
import { isSensitive } from "../llmAgent.js";
import type { AtsDriver, FieldAnswer, FieldSpec, PageSnapshot, Root } from "../types.js";

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

export const SUBMIT = /submit application|^submit$/i;
export const APPLY = /^(apply|apply now|apply for this (job|role|position)|apply to this job|i'?m interested)\b/i;
export const NEXT = /^(next|continue|save and continue|review|save|proceed)\b/i;

/**
 * Shared DOM reader/filler for ATS forms. Works on a Root (Page or Frame) so it
 * handles both inline forms and iframe-embedded ones. Concrete drivers provide
 * detect / openApplication / resolveRoot / next as needed.
 */
export abstract class GenericDriver implements AtsDriver {
  abstract readonly type: "workday" | "ashby" | "greenhouse" | "lever";
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
      const controls = [...document.querySelectorAll("input:not([type=hidden]):not([type=file]), textarea, select")].filter(isVisible);
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
        if (/^(month|year|day|from|to)$/i.test(label)) {
          const parts = [];
          let up2 = c.parentElement;
          for (let lv = 0; lv < 10 && up2 && parts.length < 2; lv += 1) {
            let t2 = "";
            const lg2 = up2.querySelector("legend, h2, h3, h4");
            if (lg2 && lg2.innerText) t2 = lg2.innerText;
            if (!t2) {
              const aid3 = up2.getAttribute("data-automation-id") || "";
              if (/^formField-/.test(aid3)) t2 = aid3.replace(/^formField-/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
              else if (/section/i.test(aid3)) t2 = aid3.replace(/([a-z])([A-Z])/g, "$1 $2");
            }
            t2 = (t2 || "").replace(/\s+/g, " ").trim();
            if (t2 && t2.toLowerCase() !== label.toLowerCase() && parts.indexOf(t2) < 0) parts.unshift(t2.slice(0, 60));
            up2 = up2.parentElement;
          }
          if (parts.length) label = (parts.join(" \u2014 ") + " \u2014 " + label).slice(0, 190);
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

    const fields: FieldSpec[] = rawFields
      .filter((f) => f.label && !SUBMIT.test(f.label))
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type as FieldSpec["type"],
        required: f.required,
        options: f.options.length ? f.options : undefined,
        sensitive: isSensitive(f.label),
        widget: f.widget === "react-select" ? "react-select" : undefined,
        searchable: f.searchable || undefined,
        filled: f.filled,
        groupKey: f.groupKey || undefined,
        groupLabel: f.groupLabel || undefined,
        groupRequired: f.groupRequired || undefined,
      }));

    // For custom dropdowns (react-select etc.), capture the real options so the
    // agent picks an EXACT option instead of us typing a free value.
    for (const field of fields) {
      // Capture options for every dropdown (incl. EEO/self-ID) so the agent picks
      // the exact option from the candidate's known data.
      if (field.widget === "react-select" && !field.options) {
        const opts = await this.captureSelectOptions(root, field.key).catch(() => undefined);
        if (opts && opts.length) field.options = opts;
      }
    }

    return { url: root.url(), fields, submitReady: await this.hasSubmit(root), nextAvailable: await this.hasNext(root) };
  }

  /** Open a custom combobox, read ITS OWN option labels (scoped to its container), and close it. */
  protected async captureSelectOptions(root: Root, keySelector: string): Promise<string[]> {
    const control = root.locator(keySelector).first();
    if (!(await control.count())) return [];
    const page = control.page();
    await page.keyboard.press("Escape").catch(() => undefined); // close any prior menu
    await page.waitForTimeout(150);
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
      const t = ((await opts.nth(i).innerText().catch(() => "")) || "").trim();
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

  async fill(root: Root, field: FieldSpec, answer: FieldAnswer): Promise<boolean> {
    const locator = root.locator(field.key).first();
    if (!(await locator.count())) return false;
    const value = answer.value;

    if (field.widget === "react-select") return this.fillReactSelect(root, locator, value, field.key);

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
    await locator.fill(value).catch(() => undefined);
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
      await locator.press("Enter").catch(() => undefined);
      await page.waitForTimeout(200);
      if (await ok()) {
        await page.keyboard.press("Escape").catch(() => undefined); // close calendar if still open
        return true;
      }
    }
    return await ok();
  }

  protected async fillReactSelect(root: Root, control: Locator, value: string, keySelector?: string): Promise<boolean> {
    const page = control.page();
    const want = value.trim().toLowerCase();
    const menu = () =>
      keySelector
        ? this.scopedOptions(root, keySelector, control)
        : Promise.resolve(root.locator('[class*="select__menu"] [class*="select__option"], [class*="select__menu"] [role="option"]'));

    // React-select menus are flaky to open (portal timing, filter re-render), so
    // retry with two open strategies: type-to-filter, then keyboard ArrowDown.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150);
      await control.scrollIntoViewIfNeeded().catch(() => undefined);
      await control.click().catch(() => undefined);
      await page.waitForTimeout(350);
      if (attempt === 1) {
        await control.press("ArrowDown").catch(() => undefined); // open without filtering
      } else {
        // Clear first. Workday's prompt keeps whatever is in its searchBox between attempts,
        // so a retry appended the text to itself ("Job BoardJob Board"), which matched no
        // option at all and turned a recoverable miss into a permanent failure.
        await control.fill("").catch(() => undefined);
        await control.pressSequentially(value.slice(0, 30), { delay: 20 }).catch(() => undefined);
      }
      // Async option lists (Greenhouse's school/discipline typeahead re-fetches per
      // keystroke and renders "Loading..." before any option) resolve after a variable
      // delay, so poll for real options instead of sampling once at a fixed wait.
      // Re-resolve menu() each round: aria-controls only exists while the menu is open.
      let opts = await menu();
      let count = 0;
      for (let wait = 0; wait < 12; wait += 1) {
        await page.waitForTimeout(250);
        opts = await menu();
        count = await opts.count().catch(() => 0);
        if (count > 0) break;
      }
      if (count === 0) continue; // menu didn't open — retry

      const texts: string[] = [];
      for (let i = 0; i < count; i += 1) texts.push(((await opts.nth(i).innerText().catch(() => "")) || "").trim());
      const lead = (t: string) => t.toLowerCase().split(/[,(:—–-]/)[0].trim();
      let idx = texts.findIndex((t) => t.toLowerCase() === want);
      if (idx < 0) idx = texts.findIndex((t) => lead(t) === want);
      if (idx < 0) idx = texts.findIndex((t) => t.toLowerCase().includes(want) || want.includes(t.toLowerCase()));
      if (idx < 0) {
        await page.keyboard.press("Escape").catch(() => undefined);
        continue; // options present but no match on this render — retry
      }
      // Click the option by its own TEXT, not by index: Workday nests several nodes per
      // option, so an index taken from the text list can land on a sibling that does nothing.
      const byText = opts.filter({ hasText: texts[idx] }).first();
      const target = (await byText.count().catch(() => 0)) > 0 ? byText : opts.nth(idx);
      await target.click().catch(() => undefined);
      await page.waitForTimeout(350);
      // Confirm a real SELECTION exists, not just text sitting in the search box. A Workday
      // prompt shows the typed string while still reporting the field empty, so a click
      // that failed to commit used to be reported as success — the field then never got
      // retried and never blocked.
      if (await this.hasSelection(root, keySelector, control)) return true;
      // Keyboard commit. Verified on a live Workday prompt: clicking the visible row can
      // leave "0 items selected", while ArrowDown + Enter commits ("1 item selected").
      await control.press("ArrowDown").catch(() => undefined);
      await page.waitForTimeout(300);
      await control.press("Enter").catch(() => undefined);
      await page.waitForTimeout(600);
      if (await this.hasSelection(root, keySelector, control)) return true;
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  /** Does this combobox hold a committed value (a react-select value or a Workday pill)? */
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
  async uploadDocuments(root: Root, resumePath: string): Promise<boolean> {
    const fileInput = root.locator('input[type="file"]').first();
    if (!(await fileInput.count().catch(() => 0))) return false;

    const already = await root
      .locator('[data-automation-id="file-upload-item"], [data-automation-id="attachment"], [class*="uploaded" i]')
      .count()
      .catch(() => 0);
    if (already > 0) return false;

    // A file input that already holds a file (same page, second pass).
    const hasFile = await fileInput
      .evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)
      .catch(() => 0);
    if (hasFile > 0) return false;

    await fileInput.setInputFiles(resumePath).catch(() => undefined);
    return true;
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
