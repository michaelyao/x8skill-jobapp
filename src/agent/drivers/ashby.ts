import type { Locator, Page } from "playwright";
import { GenericDriver } from "./base.js";
import type { FieldAnswer, FieldSpec, Root } from "../types.js";

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
