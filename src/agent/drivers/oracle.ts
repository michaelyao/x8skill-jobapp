import type { Page } from "playwright";
import { GenericDriver } from "./base.js";
import { fetchOracleVerificationCode } from "../../knowledge/oracleVerify.js";
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
   * need to have an account… your profile will be created automatically" — so passing it CREATES
   * A CANDIDATE PROFILE at that employer, and the tenant emails a one-time code to the address.
   *
   * Recognising it is what turns "stopped, 1 field, no next control" into a sentence that says why.
   */
  async atAuthGate(root: Root): Promise<boolean> {
    if (!/\/apply\/email\b/.test(root.url())) return false;
    const text = (await root.locator("body").innerText().catch(() => "")).toLowerCase();
    return text.includes("authentication screen") || text.includes("you don't need to have an account");
  }

  /** The code screen that follows the email screen on tenants that verify. */
  private codeInput(page: Page) {
    return page
      .locator(
        'input[name*="code" i]:not([name*="country" i]), input[id*="verification" i], ' +
          'input[id*="otp" i], input[autocomplete="one-time-code"], input[maxlength="6"]',
      )
      .first();
  }

  /**
   * Walk the authentication gate: email → terms → one-time code from the inbox.
   *
   * This CREATES A CANDIDATE PROFILE at the employer, which is why applyJob only calls it with
   * ORACLE_ATS=1. It fills nothing of the application itself.
   *
   * Two details are not cosmetic. The terms checkbox is 0x0 and clipped (a custom-styled control
   * whose real input is hidden), so it is ticked through its LABEL — .check() on the input alone
   * does not update the styled widget the form reads. And the email is typed with
   * pressSequentially rather than fill(), for the same reason the rest of this codebase does:
   * an instant value-set is a bot tell on a form that already ships a honeypot.
   */
  async passAuthGate(page: Page, email: string): Promise<boolean> {
    if (!(await this.atAuthGate(page))) return true; // nothing to pass

    const emailInput = page.locator('input[name="primary-email"], input[type="email"]').first();
    if (!(await emailInput.count().catch(() => 0))) {
      console.log("    [oracle] auth gate has no email input — not proceeding.");
      return false;
    }
    await emailInput.click().catch(() => undefined);
    await emailInput.pressSequentially(email, { delay: 60 }).catch(() => undefined);
    console.log(`    [oracle] auth gate — using ${email}`);

    // Tick the terms box via its label; the real input is visually hidden.
    const terms = page.locator('input[type="checkbox"]#legal-disclaimer-checkbox, input[type="checkbox"]').first();
    if (await terms.count().catch(() => 0)) {
      if (!(await terms.isChecked().catch(() => false))) {
        await terms.click({ force: true }).catch(() => undefined);
      }
      if (!(await terms.isChecked().catch(() => false))) {
        await page.locator('label[for="legal-disclaimer-checkbox"]').first().click().catch(() => undefined);
      }
      if (!(await terms.isChecked().catch(() => false))) {
        console.log("    [oracle] could not tick the terms checkbox — not proceeding.");
        return false;
      }
    }

    // Everything after this point is what makes the profile. Stamp the time FIRST: it is what
    // stops a still-recent code from a DIFFERENT tenant being accepted as this one's.
    const requestedAt = new Date();
    await this.clickNext(page);
    await this.settle(page);

    // Some tenants go straight through to the form; only wait for a code if a code is asked for.
    const wantsCode =
      (await this.codeInput(page).count().catch(() => 0)) > 0 ||
      /code (has been )?sent|enter the code|verification code|check your email/i.test(
        await page.locator("body").innerText().catch(() => ""),
      );
    if (!wantsCode) {
      console.log("    [oracle] no code requested — through the gate.");
      return !(await this.atAuthGate(page));
    }

    const timeoutMs = Number(process.env.ORACLE_CODE_TIMEOUT_MS ?? 180_000);
    console.log(`    [oracle] waiting up to ${Math.round(timeoutMs / 1000)}s for the verification code…`);
    const code = await fetchOracleVerificationCode({ timeoutMs, pollMs: 10_000, notBefore: requestedAt });
    if (!code) {
      // The profile now exists either way, so say so: a silent failure here looks like nothing
      // happened when in fact an account was created at the employer.
      console.log(
        "    [oracle] no verification code arrived in time. The candidate profile HAS been created; " +
          "the code may still turn up in the inbox.",
      );
      return false;
    }

    const input = this.codeInput(page);
    if (!(await input.count().catch(() => 0))) {
      console.log(`    [oracle] got code ${code} but found no field to type it into.`);
      return false;
    }
    await input.click().catch(() => undefined);
    await input.pressSequentially(code, { delay: 80 }).catch(() => undefined);
    console.log(`    [oracle] entered the verification code.`);
    await this.clickNext(page);
    await this.settle(page);

    const stillGated = await this.atAuthGate(page);
    if (stillGated) console.log("    [oracle] still on the authentication screen after the code — it was not accepted.");
    return !stillGated;
  }

  async next(root: Root): Promise<boolean> {
    if (await this.atAuthGate(root)) {
      // Only applyJob knows the profile email, and only it should decide to create an account.
      console.log("    [oracle] at the authentication gate — passAuthGate() has to run before the form.");
      return false;
    }
    return this.clickNext(root);
  }
}
