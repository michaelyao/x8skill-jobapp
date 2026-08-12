import type { Page } from "playwright";
import { BaseAdapter } from "./base.js";
import type { FillContext, FillResult } from "../types.js";

export class AshbyAdapter extends BaseAdapter {
  readonly type = "ashby" as const;

  async detect(page: Page): Promise<boolean> {
    return page.url().toLowerCase().includes("ashbyhq.com");
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
      console.log("[ashby] clicked Apply to open the application form.");
    }

    const filled: string[] = [];
    const unknownQuestions = [];

    for (let step = 0; step < 10; step += 1) {
      console.log(`[ashby] step=${step} url=${context.page.url()}`);

      if (await this.hasFinalSubmit(context.page)) {
        console.log("[ashby] final submit detected; stopping for manual review.");
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
        console.log("[ashby] no continue button found; stopping.");
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
