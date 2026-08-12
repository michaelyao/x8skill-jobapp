import type { Page } from "playwright";
import { GenericDriver, SUBMIT } from "./base.js";
import type { Root } from "../types.js";

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
