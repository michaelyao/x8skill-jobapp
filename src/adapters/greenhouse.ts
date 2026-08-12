import type { Page } from "playwright";
import { BaseAdapter } from "./base.js";
import type { FillContext, FillResult } from "../types.js";

export class GreenhouseAdapter extends BaseAdapter {
  readonly type = "greenhouse" as const;

  async detect(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    // Greenhouse's own domains, plus forms embedded on a company's career site
    // (those carry a gh_jid param, e.g. careers.roblox.com/jobs/123?gh_jid=123).
    if (url.includes("greenhouse.io") || url.includes("gh_jid=")) {
      return true;
    }
    // Fallback: a Greenhouse application form embedded in the page DOM/iframe.
    const embedded = await page
      .locator('#grnhse_app, iframe[src*="greenhouse.io"], form[action*="greenhouse.io"]')
      .count()
      .catch(() => 0);
    return embedded > 0;
  }

  async fill(context: FillContext): Promise<FillResult> {
    await context.page.waitForLoadState("domcontentloaded");
    await context.page.waitForTimeout(1500);

    const alreadyApplied = await this.checkAlreadyApplied(context.page);
    if (alreadyApplied) {
      return { filled: [], skipped: ["already applied"], unknownQuestions: [], alreadyApplied: true, reachedReview: false };
    }

    // Open the application form if the posting shows the JD with an Apply button.
    if (await this.clickApplyButton(context.page)) {
      console.log("[greenhouse] clicked Apply to open the application form.");
    }

    const filled: string[] = [];
    const unknownQuestions = [];

    for (let step = 0; step < 10; step += 1) {
      console.log(`[greenhouse] step=${step} url=${context.page.url()}`);

      if (await this.hasFinalSubmit(context.page)) {
        console.log("[greenhouse] final submit detected; stopping for manual review.");
        return { filled, skipped: [], unknownQuestions, alreadyApplied: false, reachedReview: true };
      }

      await this.uploadCommonDocuments(context.page, context.resumePath);
      const result = await this.fillStandardFields(context);
      filled.push(...result.filled);
      unknownQuestions.push(...result.unknownQuestions);

      if (await this.hasFinalSubmit(context.page)) {
        return { filled, skipped: [], unknownQuestions, alreadyApplied: false, reachedReview: true };
      }

      const advanced = await this.clickContinue(context.page);
      if (!advanced) {
        console.log("[greenhouse] no continue button found; stopping.");
        break;
      }
      await context.page.waitForTimeout(1500);
    }

    return {
      filled,
      skipped: [],
      unknownQuestions,
      alreadyApplied: false,
      reachedReview: await this.hasFinalSubmit(context.page),
    };
  }
}
