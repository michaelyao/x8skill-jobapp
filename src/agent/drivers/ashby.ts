import type { Page } from "playwright";
import { GenericDriver } from "./base.js";
import type { Root } from "../types.js";

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
}
