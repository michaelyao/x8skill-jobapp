import type { Locator, Page } from "playwright";
import { GenericDriver } from "./base.js";
import type { FieldAnswer, FieldSpec, PageSnapshot, Root } from "../types.js";

/**
 * Ashby driver — the application form renders inline on jobs.ashbyhq.com. Some
 * postings show the JD first with an "Apply" button; multi-step forms use a
 * next/continue control.
 */
export class AshbyDriver extends GenericDriver {
  readonly type = "ashby" as const;

  async detect(page: Page): Promise<boolean> {
    return page.url().toLowerCase().includes("ashbyhq.com");
  }

  /**
   * Ashby's YES/NO widget is invisible to the generic reader, and five REQUIRED questions on one
   * application went unanswered because of it — sponsorship, "Do you currently reside in Houston,
   * TX?", and three experience questions. Not filled, not blocked by the required-field gate, not
   * shown on the review page: the form asks eighteen questions and read() returned twelve.
   *
   * The markup is a pair of buttons over a hidden checkbox:
   *
   *   <label class="… _required_ …" for="UUID">Do you currently reside in Houston, TX?</label>
   *   <div class="… ashby-application-form-input-yesno">
   *     <button aria-pressed="false" data-option="yes">Yes</button>
   *     <button aria-pressed="false" data-option="no">No</button>
   *   </div>
   *   <input type="checkbox" style="display:none" name="UUID">
   *
   * read() keeps only controls that are visible — rightly, or every hidden input on a page becomes
   * a field — and the checkbox carrying the answer has `display: none`. The buttons are the control;
   * the checkbox is just where the value lands.
   *
   * Required comes from a CLASS on the question label (`_required_…`), not from an attribute, which
   * is separately why every Ashby question this driver DOES see has been recorded as optional.
   */
  private static readonly YESNO = '[class*="ashby-application-form-input-yesno"]';

  async read(root: Root): Promise<PageSnapshot> {
    const snapshot = await super.read(root);
    const found = (await root
      .evaluate(`(() => {
        var out = [];
        // The class prefix also appears on each option BUTTON, so matching it alone finds the
        // container plus its two buttons — the same question three times over. A container is the
        // one that HOLDS the buttons.
        var all = document.querySelectorAll('[class*="ashby-application-form-input-yesno"]');
        var groups = [];
        for (var gi = 0; gi < all.length; gi += 1) {
          if (all[gi].tagName !== "BUTTON" && all[gi].querySelector("button[data-option]")) groups.push(all[gi]);
        }
        for (var i = 0; i < groups.length; i += 1) {
          var g = groups[i];
          /**
           * The checkbox carrying the answer is a SIBLING of the button group. Asking the parent
           * for "an input[type=checkbox]" returns the first one in its subtree, which on a flatter
           * tenant is the previous question's — every question would then resolve to one name and
           * collapse into a single field. Walk forward from the group instead.
           */
          // Inside the group first — that one can only be its own. Tenants differ on whether the
          // checkbox sits within the button container or beside it.
          var hidden = g.querySelector('input[type="checkbox"]');
          var sib = g.nextElementSibling;
          while (sib && !hidden) {
            if (sib.tagName === "INPUT" && sib.getAttribute("type") === "checkbox") hidden = sib;
            else if (sib.querySelector) hidden = sib.querySelector('input[type="checkbox"]');
            if (sib.tagName === "LABEL") break; // the next question has started
            sib = sib.nextElementSibling;
          }
          var name = hidden ? hidden.getAttribute("name") : null;
          // The question label points AT the field by id, which is the same uuid the input carries.
          var label = name ? document.querySelector('label[for="' + name + '"]') : null;
          if (!label) {
            var prev = g.previousElementSibling;
            label = prev && prev.tagName === "LABEL" ? prev : null;
          }
          var buttons = g.querySelectorAll("button[data-option]");
          var chosen = "";
          for (var b = 0; b < buttons.length; b += 1) {
            if (buttons[b].getAttribute("aria-pressed") === "true") chosen = (buttons[b].textContent || "").trim();
          }
          out.push({
            name: name || "",
            label: label ? (label.textContent || "").replace(/\\s+/g, " ").trim() : "",
            required: label ? /_required_/.test(String(label.className)) : false,
            options: Array.prototype.map.call(buttons, function (b) { return (b.textContent || "").trim(); }),
            filled: chosen !== "",
          });
        }
        return out;
      })()`)
      .catch(() => [])) as Array<{ name: string; label: string; required: boolean; options: string[]; filled: boolean }>;

    const known = new Set(snapshot.fields.map((f) => f.label));
    for (const g of found) {
      if (!g.label || !g.name || known.has(g.label)) continue;
      snapshot.fields.push({
        // The container is the question label's next sibling. The hidden checkbox is a sibling of
        // the container, not a child, so a `:has(input…)` selector would match nothing.
        key: `label[for="${g.name}"] + ${AshbyDriver.YESNO}`,
        label: g.label,
        type: "single_select",
        required: g.required,
        options: g.options.length ? g.options : ["Yes", "No"],
        filled: g.filled,
      });
    }
    return snapshot;
  }

  async openApplication(page: Page): Promise<void> {
    await this.clickApply(page);
    await page.waitForTimeout(1000);
  }

  async next(root: Root): Promise<boolean> {
    return this.clickNext(root);
  }

  /**
   * Ashby's "Location" is a TYPEAHEAD, and a country one.
   *
   *   <div data-field-path="_systemfield_location">
   *     <label class="… _required_ …">Location</label>
   *     <input role="combobox" aria-autocomplete="list" placeholder="Start typing…">
   *
   * Nothing exists until you type: clicking it yields ZERO options, so the reader recorded
   * `single_select` with `options: []`, the agent had nothing to choose from, and the field was
   * left empty (KRSNTB). Typing reveals what it really wants —
   *
   *   "United"   -> United States | United Kingdom | United Arab Emirates | US Virgin Islands
   *   "a"        -> United States | Australia | Argentina | Azerbaijan | Albania
   *   "Sunnyval" -> Sunnyvale, California, United States
   *
   * So it is a LOCATION typeahead, not a country list — a first look at the country-shaped results
   * suggested otherwise, and it resolves the profile's own location more precisely than "United
   * States" would. The country is the FALLBACK, for a place the list does not carry.
   *
   * Note the label carries a `_required_` class rather than `required`/`aria-required`, which is
   * also why the reader recorded this required field as optional.
   *
   * Typing then picking is the only thing that works: the value must come from the listbox, so a
   * plain fill() leaves the widget with text and no selection. Verified by reading the input back.
   */
  async fill(root: Root, field: FieldSpec, answer: FieldAnswer): Promise<boolean> {
    /**
     * The yes/no widget is driven by CLICKING one of its buttons — the checkbox behind it is
     * display:none, so check() has nothing to act on. Verified by reading `aria-pressed` back,
     * because a click that dispatched without registering must never be reported as filled.
     */
    if (field.key.includes("ashby-application-form-input-yesno")) {
      const wanted = (answer.value || "").trim().toLowerCase();
      if (!wanted) return false;
      const group = root.locator(field.key).first();
      if (!(await group.count().catch(() => 0))) return false;
      // Match the button by its own text first, then by the data-option Ashby stamps on it.
      const byText = group.locator("button[data-option]").filter({ hasText: new RegExp(`^\\s*${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") });
      const byOption = group.locator(`button[data-option="${/^y/.test(wanted) ? "yes" : "no"}"]`);
      const target = (await byText.count().catch(() => 0)) > 0 ? byText.first() : byOption.first();
      if (!(await target.count().catch(() => 0))) return false;
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.click().catch(() => undefined);
      await group.page().waitForTimeout(250);
      return (await target.getAttribute("aria-pressed", { timeout: 2_000 }).catch(() => null)) === "true";
    }

    const isTypeahead =
      /location|country/i.test(field.label ?? "") && (field.options?.length ?? 0) === 0;
    if (isTypeahead) {
      const combo = (root as Page)
        .locator('[data-field-path*="location" i] input[role="combobox"], input[role="combobox"]')
        .first();
      if ((await combo.count().catch(() => 0)) > 0) {
        const wanted = (answer.value || "").trim() || "United States";
        if (await this.pickFromTypeahead(root, combo, wanted)) return true;
        // A country list will not contain "Sunnyvale, CA"; fall back to the country itself before
        // giving up, rather than leaving a required field empty.
        if (wanted !== "United States" && (await this.pickFromTypeahead(root, combo, "United States"))) {
          /**
           * SAY WHAT WAS ACTUALLY FILLED. The fallback used to return true while the recorded
           * answer stayed "Pittsburgh, PA", so the review page showed one value and the form held
           * another — the visual cross-check caught it on two applications ("Location was recorded
           * as Pittsburgh, PA but the screen shows United States") and it would have been refused
           * at submit by compareToApproved. turnLoop reads answer.value AFTER the fill, so
           * correcting it here is what makes the record faithful.
           */
          answer.value = "United States";
          return true;
        }
        return false;
      }
    }
    return super.fill(root, field, answer);
  }

  /** Type, wait for the list, click the best option, and prove the input kept it. */
  private async pickFromTypeahead(root: Root, combo: Locator, wanted: string): Promise<boolean> {
    await combo.click().catch(() => undefined);
    await combo.fill("").catch(() => undefined);
    // Type a PREFIX. The list filters as you go, and the full string can over-filter to nothing
    // ("United States of America" matches no entry in a list that says "United States").
    await combo.pressSequentially(wanted.slice(0, 8), { delay: 60 }).catch(() => undefined);

    const options = root.locator('[role="option"]');
    try {
      await options.first().waitFor({ state: "visible", timeout: 8000 });
    } catch {
      return false; // the list never opened — say so rather than report a fill
    }

    const texts = await options.allInnerTexts().catch(() => [] as string[]);
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    let index = texts.findIndex((t) => norm(t) === norm(wanted));
    if (index < 0) index = texts.findIndex((t) => norm(t).startsWith(norm(wanted)));
    if (index < 0) return false; // never take "the first option" — that is how a wrong country lands

    await options.nth(index).click().catch(() => undefined);
    await (root as Page).waitForTimeout(400);
    const got = norm(await combo.inputValue().catch(() => ""));
    if (!got) return false;
    console.log(`      ✓ Location → ${JSON.stringify(texts[index].trim())}`);
    return true;
  }
}
