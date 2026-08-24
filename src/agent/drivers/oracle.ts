import type { Page } from "playwright";
import { GenericDriver } from "./base.js";
import type { Root } from "../types.js";

/**
 * Oracle HCM "CandidateExperience" driver — the tenant-hosted careers site behind
 * *.oraclecloud.com/hcmUI/CandidateExperience/... (American Express, JPMorgan, onsemi and a lot
 * of large employers). 19 roles on the current list across ~8 tenants, so it is the biggest
 * unsupported family by volume.
 *
 * NOT in SUPPORTED_ATS by default — see selectJobs.ts. Set ORACLE_ATS=1 to opt in. Everything
 * below is verified live (American Express, Aug 2026) UP TO the authentication gate, and the gate
 * is a decision rather than a bug: see the note on it further down.
 *
 * Three things about this ATS that are not guesses:
 *
 * 1. IT IS AN SPA WITH CLIENT-SIDE ROUTING, so the apply screen cannot be deep-linked. Navigating
 *    straight to …/job/{id}/apply/email renders a page with ZERO fields; the same URL reached by
 *    clicking "Apply Now" renders the form. openApplication must click, never goto.
 *
 * 2. IT REDIRECTS ON FIRST LOAD, which destroys the execution context mid-evaluate — a read
 *    issued too early fails with "Execution context was destroyed" and looks like an empty page.
 *    settle() waits for networkidle before anything reads the DOM.
 *
 * 3. IT SHIPS A HONEYPOT: <input name="honey-pot" aria-hidden="true"> on the apply screen. It
 *    passes the offsetParent/getClientRects visibility test, so it is read as an ordinary field
 *    unless something excludes it — filling it announces us as a bot on every application. The
 *    guard lives in GenericDriver.read() (isBotTrap) because it protects every ATS, not just this
 *    one. Note the contrast with the REQUIRED "I agree with the terms and conditions" checkbox on
 *    the same screen: that one is 0x0 and clipped, and must still be filled. Size is not evidence.
 */
export class OracleDriver extends GenericDriver {
  readonly type = "oracle" as const;

  async detect(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    return url.includes("oraclecloud.com") && url.includes("candidateexperience");
  }

  /** This SPA renders after its own redirect + XHRs; reading before that returns an empty page. */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(Number(process.env.ORACLE_SETTLE_MS ?? 2000));
  }

  /**
   * Wait for the control, do not sleep and hope. A fixed settle looked fine and then clicked
   * nothing: "Apply Now" renders late enough that networkidle + 3s still missed it, and the run
   * reported 0 fields and no next control — indistinguishable from a page we cannot read. Waiting
   * on the button, then on the URL actually changing, makes the failure say which step failed.
   */
  async openApplication(page: Page): Promise<void> {
    await this.settle(page);

    const apply = page
      .getByRole("button", { name: /apply now|^apply$/i })
      .or(page.getByRole("link", { name: /apply now|^apply$/i }))
      .first();
    try {
      await apply.waitFor({ state: "visible", timeout: 25_000 });
    } catch {
      console.log("    [oracle] no Apply control appeared — the posting may be closed, or the site did not render.");
      return;
    }

    // Dismiss consent and LET IT GO AWAY before clicking. The banner is a fixed overlay that
    // animates out: clicking Apply in the same tick lands on the banner, the route never changes,
    // and it reads as "Apply did nothing". This is the second time the same overlay caused that —
    // Workable's Apply button had the identical symptom.
    const consent = page.getByRole("button", { name: /accept all|accept cookies|got it/i }).first();
    if (await consent.isVisible().catch(() => false)) {
      await consent.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }
    await apply.click().catch(() => undefined);

    // The apply screen is a client-side route: the URL gains /apply/. If it never does, the click
    // was swallowed (usually by a consent overlay) and saying so beats reporting an empty form.
    await page.waitForURL(/\/apply\b/, { timeout: 25_000 }).catch(() => undefined);
    await this.settle(page);
    if (!/\/apply\b/.test(page.url())) {
      console.log(`    [oracle] Apply was clicked but the route did not change (still ${page.url()}).`);
    }
  }

  async resolveRoot(page: Page): Promise<Root> {
    return page;
  }

  /**
   * The authentication gate. Oracle puts an email screen in front of the application — "You don't
   * need to have an account… your profile will be created automatically" — which means reaching
   * the real form CREATES A CANDIDATE PROFILE at that employer, and on most tenants sends a
   * verification code to the address first.
   *
   * That is a decision, not an implementation detail, so this reports the gate instead of walking
   * through it. Recognising it is what turns "stopped, 1 field, no next control" into a sentence
   * that says why.
   */
  async atAuthGate(root: Root): Promise<boolean> {
    if (!/\/apply\/email\b/.test(root.url())) return false;
    const text = (await root.locator("body").innerText().catch(() => "")).toLowerCase();
    return text.includes("authentication screen") || text.includes("you don't need to have an account");
  }

  async next(root: Root): Promise<boolean> {
    if (await this.atAuthGate(root)) {
      console.log(
        "    [oracle] authentication gate — this tenant wants an email before the form, and " +
          "continuing would create a candidate profile (usually with an emailed verification " +
          "code). Not proceeding; see src/agent/drivers/oracle.ts.",
      );
      return false;
    }
    return this.clickNext(root);
  }
}
