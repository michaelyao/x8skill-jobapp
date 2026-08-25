import type { Page } from "playwright";
import { GenericDriver, SUBMIT } from "./base.js";
import type { Root } from "../types.js";

const SUBMIT_BTN = 'button[type="submit"], input[type="submit"]';

/**
 * Workable driver (apply.workable.com). Single page, no login: the posting lives at
 * /{company}/j/{ID}/ and the whole application — personal details, resume upload and any custom
 * questions — is one form at /{company}/j/{ID}/apply/ ending in "Submit application". Like Lever,
 * there is no multi-step Next, so we fill, reach Submit (= review) and only click on approval.
 *
 * Verified live (pony.ai, Aug 2026): firstname, lastname, email, phone, address, city, postcode,
 * country, summary, cover_letter and an input[type=file] marked data-testid="resume".
 *
 * THE COOKIE BANNER IS LOAD-BEARING. Workable renders consent as a fixed overlay, and with it up
 * the "Apply for this job" button is visible and enabled but the click lands on the banner: the
 * URL never changes and the form never appears, which reads exactly like "Apply did nothing".
 * clickApply() in the base dismisses it first, which is why openApplication goes through it
 * rather than navigating straight to /apply/.
 */
export class WorkableDriver extends GenericDriver {
  readonly type = "workable" as const;

  async detect(page: Page): Promise<boolean> {
    return /(^|\.)workable\.com\//i.test(page.url());
  }

  private async hasForm(page: Page): Promise<boolean> {
    return (
      (await page
        .locator('input[name="firstname"], input[name="lastname"], input[name="email"], form')
        .count()
        .catch(() => 0)) > 0
    );
  }

  async openApplication(page: Page): Promise<void> {
    // A withdrawn posting 302s to /{company}/?not_found=true — the company's JOB SEARCH page.
    // applyJob() catches this earlier by page text ("this job is no longer available"), but bail
    // out here too: the fallback below would otherwise build /{company}/apply/ out of the
    // redirected URL and read the search filters (Workplace type, Location, Work type) as if they
    // were application fields.
    const original = page.url();
    if (/[?&]not_found=true/.test(original)) {
      console.log("    [workable] the posting redirected to the company job list — it is no longer available.");
      return;
    }
    if (await this.hasForm(page)) return;

    await this.clickApply(page); // dismisses the consent overlay, then clicks Apply
    await page.waitForTimeout(1500);
    if (await this.hasForm(page)) return;
    if (/[?&]not_found=true/.test(page.url())) {
      console.log("    [workable] Apply led to the company job list — the posting is no longer available.");
      return;
    }

    // Fallback: the canonical apply URL, derived from the URL we ARRIVED with rather than wherever
    // a redirect left us — building it from the current URL is what produced /{company}/apply/.
    const base = original.split("?")[0].replace(/\/(apply\/?)?$/, "");
    if (!/\/j\/[0-9A-F]+/i.test(base)) return; // not a posting URL; nothing safe to construct
    await page.goto(`${base}/apply/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(2000);
  }

  /**
   * Expand the collapsed Education and Experience sections.
   *
   * Workable renders these as repeatable sections with NO fields until "+ Add" is clicked, and
   * labels them "(Optional)". So the reader saw eight fields — name, email, phone, address,
   * summary, cover letter — found nothing missing, and the run reported `reached review` with the
   * education and work history of the application completely empty. Optional to Workable; not
   * optional on an internship application. Caught on Pony.ai ZNSIQU.
   *
   * Scoped by aria-label ("Add Education" / "Add Experience"), which the buttons carry — their
   * visible text is just "+ Add" on both, so anything positional would be a coin flip.
   *
   * Idempotent: it probes for the section's fields first, so a re-fill of a form that already has
   * an entry does not stack empty ones. Verified by counting controls before and after, because a
   * click that expanded nothing must not be reported as an expansion.
   */
  private async expandSections(page: Page): Promise<void> {
    const sections: Array<[string, RegExp]> = [
      ["education", /^add education$/i],
      ["experience", /^add experience$/i],
    ];
    for (const [name, label] of sections) {
      const existing = await page
        .locator(`[id*="${name}" i], [name*="${name}" i], [data-testid*="${name}" i]`)
        .locator("input, select, textarea")
        .count()
        .catch(() => 0);
      if (existing > 0) continue; // already expanded (or pre-filled by the resume parser)

      const button = page.getByRole("button", { name: label }).first();
      if (!(await button.isVisible().catch(() => false))) continue;

      const before = await page.locator("input:not([type=hidden]), select, textarea").count().catch(() => 0);
      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      await button.click().catch(() => undefined);
      await page.waitForTimeout(900);
      const after = await page.locator("input:not([type=hidden]), select, textarea").count().catch(() => 0);
      if (after > before) console.log(`    [workable] expanded ${name} (+${after - before} field(s))`);
      else console.log(`    [workable] "+ Add" for ${name} revealed no fields — leaving it collapsed.`);
    }
  }

  async resolveRoot(page: Page): Promise<Root> {
    // Expanding here rather than in openApplication: turnLoop re-reads every turn, and a section
    // that collapses (or a form re-rendered after an upload) has to be re-expanded before the read
    // that decides whether anything is still missing.
    await this.expandSections(page).catch(() => undefined);
    return page;
  }

  protected async hasNext(): Promise<boolean> {
    return false; // single-page form
  }

  async next(): Promise<boolean> {
    return false; // Submit is the only control
  }

  protected async hasSubmit(root: Root): Promise<boolean> {
    if ((await root.locator(SUBMIT_BTN).count().catch(() => 0)) > 0) return true;
    return (await root.getByRole("button", { name: SUBMIT }).count().catch(() => 0)) > 0;
  }

  /** Click the final Submit — only ever invoked after explicit approval. */
  async submit(root: Root): Promise<boolean> {
    const byRole = root.getByRole("button", { name: SUBMIT }).first();
    if (await byRole.count().catch(() => 0)) {
      await byRole.scrollIntoViewIfNeeded().catch(() => undefined);
      await byRole.click().catch(() => undefined);
      return true;
    }
    const btn = root.locator(SUBMIT_BTN).first();
    if (await btn.count().catch(() => 0)) {
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      await btn.click().catch(() => undefined);
      return true;
    }
    return false;
  }
}
