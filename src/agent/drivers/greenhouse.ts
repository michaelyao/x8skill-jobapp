import type { Page } from "playwright";
import { GenericDriver } from "./base.js";
import type { Root } from "../types.js";

/**
 * Greenhouse driver — frame-aware. Greenhouse forms are often embedded on a
 * company's own domain (e.g. careers.roblox.com) inside a
 * job-boards.greenhouse.io iframe that appears after clicking "Apply".
 */
export class GreenhouseDriver extends GenericDriver {
  readonly type = "greenhouse" as const;

  async detect(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes("greenhouse.io") || url.includes("gh_jid=")) return true;
    const embedded = await page
      .locator('#grnhse_app, iframe[src*="greenhouse.io"], form[action*="greenhouse.io"]')
      .count()
      .catch(() => 0);
    return embedded > 0;
  }

  async openApplication(page: Page): Promise<void> {
    await this.clickApply(page);
    await page.waitForTimeout(1500); // let the greenhouse embed iframe attach
  }

  async resolveRoot(page: Page): Promise<Root> {
    return page.frames().find((f) => /greenhouse\.io/i.test(f.url())) ?? page;
  }

  // Greenhouse applications are a single page ending in Submit — no next.
  async next(): Promise<boolean> {
    return false;
  }
}
