import type { Page } from "playwright";
import { GenericDriver, SUBMIT } from "./base.js";
import type { FieldAnswer, FieldSpec, Root } from "../types.js";

const SUBMIT_BTN = '#btn-submit, button[type="submit"], input[type="submit"]';

/**
 * Lever driver (jobs.lever.co). Single-page, no login: the whole application —
 * profile fields, resume upload, and custom "cards" questions — is one form with
 * a single "Submit application" button at the bottom. There is no multi-step Next,
 * so hasNext is false and hasSubmit is true once the form is present. We fill,
 * reach the Submit control (= review), and only click it on explicit approval.
 */
export class LeverDriver extends GenericDriver {
  readonly type = "lever" as const;

  async detect(page: Page): Promise<boolean> {
    return /(^|\.)lever\.co\//i.test(page.url());
  }

  async openApplication(page: Page): Promise<void> {
    await page.getByRole("button", { name: /accept|got it|agree/i }).first().click({ timeout: 2000 }).catch(() => undefined);

    // If we're on the posting page (no form yet), go to the /apply form.
    const hasForm = async () =>
      (await page.locator('input[name="name"], input[name="email"], form[action*="apply"], #application-form').count().catch(() => 0)) > 0;

    if (!(await hasForm())) {
      // Prefer navigating directly to the canonical /apply URL.
      const url = page.url().split("?")[0].replace(/\/$/, "");
      if (!/\/apply$/.test(url)) {
        await page.goto(`${url}/apply`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        await page.waitForTimeout(2000);
      }
    }
    // Fallback: click a visible "Apply for this job" button/link.
    if (!(await hasForm())) {
      const apply = page.getByRole("link", { name: /apply for this job|apply now|^apply$/i }).or(page.getByRole("button", { name: /apply for this job|apply now|^apply$/i })).first();
      if (await apply.isVisible().catch(() => false)) {
        await apply.click().catch(() => undefined);
        await page.waitForTimeout(2000);
      }
    }
  }

  async resolveRoot(page: Page): Promise<Root> {
    return page;
  }

  protected async hasNext(): Promise<boolean> {
    return false; // single-page form
  }

  async next(): Promise<boolean> {
    return false; // nothing to advance — Submit is the only control
  }

  protected async hasSubmit(root: Root): Promise<boolean> {
    if ((await root.locator(SUBMIT_BTN).count().catch(() => 0)) > 0) return true;
    return (await root.getByRole("button", { name: SUBMIT }).count().catch(() => 0)) > 0;
  }

  /**
   * "Current location" IS A TYPEAHEAD, AND TYPING INTO IT IS NOT ANSWERING IT.
   *
   * ACDS MWSNDJ was blocked on this field six times. The log said "reported filled but reads empty
   * 3× — no longer trusting that", and study mode described a perfectly ordinary text input:
   * enabled, writable, topmost, nothing covering it. Both were true. What neither could see is
   * that Lever pairs the visible `input[name=location]` with a hidden `input[name=selectedLocation]`
   * and a `.dropdown-results` list: the typed text is a SEARCH, and anything not chosen from the
   * list is discarded when focus leaves. We typed, moved on, and the value evaporated behind us.
   *
   * Measured in real headed Chrome on that posting: at +500ms the box holds "Sunnyvale" and the
   * list is empty; at +1500ms it offers "Sunnyvale, CA, USA", "Sunnyvale, TX, USA", "Sunnyvale, MO,
   * USA", "Sunnyvale, NC, USA". So the row has to be waited for, and then CLICKED — never Enter,
   * which on a single-page form with a submit button is one missed condition away from filing.
   *
   * A NOTE ON THE WRONG TURN THIS TOOK. Headless, the same page answers differently: an hCaptcha
   * takes the keyboard focus, the typing never lands, and the list stays empty. That is what a
   * throwaway browser gets challenged with, not what the worker sees — the worker drives real
   * headed Chrome on the persistent profile and is never challenged here. Diagnosing an ATS in a
   * browser unlike the one that failed is how "it is behind a CAPTCHA" got written down about a
   * field that simply needed its suggestion clicked.
   */
  async fill(root: Root, field: FieldSpec, answer: FieldAnswer): Promise<boolean> {
    const isLocation = /location-input/.test(field.key) || /^current location/i.test(field.label);
    if (!isLocation) return super.fill(root, field, answer);

    const input = root.locator(field.key).first();
    const wanted = answer.value.trim();
    if (!wanted) return super.fill(root, field, answer);

    const committed = async () =>
      Boolean(
        (await input.inputValue().catch(() => "")).trim() &&
          (await root
            .locator('#selected-location, input[name="selectedLocation"]')
            .first()
            .inputValue()
            .catch(() => "")).trim(),
      );

    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    await input.click().catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.pressSequentially(wanted, { delay: 70 }).catch(() => undefined);

    const rows = root.locator(".dropdown-results > *");
    for (let waited = 0; waited < 8_000; waited += 400) {
      await input.page().waitForTimeout(400);
      if ((await rows.count().catch(() => 0)) > 0) break;
    }
    const offered = await rows.allInnerTexts().catch(() => [] as string[]);
    if (!offered.length) {
      console.log(`    [lever] "${field.label.slice(0, 40)}": no suggestion appeared for ${JSON.stringify(wanted)}`);
      return false;
    }

    /**
     * Prefer a row the answer actually agrees with. The store says Sunnyvale, CA, and Lever offers
     * Sunnyvale in four states — taking the first row would put the candidate in Texas.
     */
    const tokens = wanted.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 1);
    let best = 0;
    let bestScore = -1;
    offered.forEach((text, i) => {
      const low = text.toLowerCase();
      const score = tokens.filter((t) => low.includes(t)).length;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    console.log(`    [lever] "${field.label.slice(0, 34)}": ${offered.length} suggestion(s), taking ${JSON.stringify(offered[best]?.slice(0, 40))}`);
    await rows.nth(best).click().catch(() => undefined);
    await input.page().waitForTimeout(400);

    // Confirmed by the HIDDEN field, which is what the form actually requires. A visible box
    // holding text proves nothing here — that was the whole failure.
    if (await committed()) return true;
    console.log(`    [lever] the suggestion did not commit — selectedLocation is still empty`);
    return false;
  }

  /** Click the final Submit — only ever invoked after explicit approval. */
  async submit(root: Root): Promise<boolean> {
    const btn = root.locator(SUBMIT_BTN).first();
    if (await btn.count().catch(() => 0)) {
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      await btn.click().catch(() => undefined);
      return true;
    }
    const byRole = root.getByRole("button", { name: SUBMIT }).first();
    if (await byRole.count().catch(() => 0)) {
      await byRole.click().catch(() => undefined);
      return true;
    }
    return false;
  }
}
