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

  /**
   * Clear Oracle's modal <dialog class="app-dialog">, which carries the tenant's terms and an
   * "Agree" button and is open over the apply screen.
   *
   * This is the step whose absence made everything else look broken. While it is up it intercepts
   * every real click, so: label clicks time out with no reason given, Next reads as disabled, and
   * the ONLY thing that can move the terms checkbox is a synthetic dispatchEvent — which sets the
   * property without the form's viewmodel agreeing. That combination reads as four different
   * mysteries; it is one modal.
   *
   * Consequently, dispatchEvent "working" earlier was a false success of exactly the kind
   * CLAUDE.md warns about: isChecked() said true while the form still refused to advance. Real
   * clicks work fine once the dialog is gone.
   */
  async dismissDialog(page: Page): Promise<boolean> {
    // Find the VISIBLE dialog, not the first one in the DOM. This page carries several dialog
    // elements that stay hidden (session timeout, discard confirmation), so .first() resolves to a
    // hidden one, isVisible() is false, and this returns having done nothing — which is exactly
    // how the modal survived the first attempt at dismissing it.
    const all = page.locator("dialog[open], dialog.app-dialog, [role=dialog]");
    const count = await all.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const dialog = all.nth(i);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      for (const name of [/^agree$/i, /^i agree$/i, /^accept$/i, /^ok$/i, /^continue$/i, /^close$/i]) {
        const btn = dialog.getByRole("button", { name }).first();
        if (!(await btn.isVisible().catch(() => false))) continue;
        await btn.click().catch(() => undefined);
        await page.waitForTimeout(1200);
        const gone = !(await dialog.isVisible().catch(() => false));
        console.log(`    [oracle] terms dialog ${gone ? "dismissed" : "still open"} via ${String(name)}.`);
        return gone;
      }
      console.log("    [oracle] a dialog is open but none of the expected buttons are in it.");
      return false;
    }
    return false; // nothing open
  }

  /**
   * Tick "I agree with the terms and conditions".
   *
   * The real input is `class="input-row__hidden-control"` — deliberately hidden — inside a
   * wrapping <label for>, with the control a human actually clicks being its SIBLING
   * <span class="apply-flow-input-checkbox">. It is a Knockout binding
   * (data-bind="checked: legalDisclaimer.isAccepted"), so what matters is that a real click
   * reaches the visible span and fires change on the input.
   *
   * IT IS NOT A CHECKBOX YOU CLICK. The span is the terms LINK: clicking it opens a modal
   * <dialog class="app-dialog"> containing the tenant's terms and an "Agree" button, and it is
   * AGREE that ticks the box. Measured on American Express (Aug 2026):
   *
   *   click span  → checked=false, dialog opens
   *   click Agree → checked=true, Next enabled
   *
   * Everything confusing about this control was that one modal. While it is up it swallows real
   * clicks, so the label times out with no reason given, check({force}) reports "outside of the
   * viewport", and Next reads as disabled — three unrelated-looking symptoms with one cause.
   *
   * An earlier version "succeeded" here with dispatchEvent("click"), which sets input.checked
   * without the viewmodel agreeing: isChecked() said true, Next stayed disabled, and the gate
   * would not advance. That is precisely the false success CLAUDE.md forbids, and it is why
   * success is now judged by BOTH signals — the box is checked AND the form will move — rather
   * than by the property alone. Do not reintroduce a dispatched click here.
   */
  async tickTerms(page: Page): Promise<boolean> {
    // Scope to the id. A bare input[type=checkbox] + .first() would silently pick some other
    // checkbox appearing earlier in the DOM and tick that instead.
    const input = page.locator("#legal-disclaimer-checkbox").first();
    if (!(await input.count().catch(() => 0))) return true; // no terms box on this tenant
    const nextBtn = page.getByRole("button", { name: /^next$/i }).first();
    const accepted = async () =>
      (await input.isChecked().catch(() => false)) && (await nextBtn.isEnabled().catch(() => true));
    if (await accepted()) return true;

    const terms = page.locator("span.apply-flow-input-checkbox, #legal-disclaimer-checkbox ~ span").first();
    await terms.scrollIntoViewIfNeeded().catch(() => undefined);
    await terms.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(1200);

    // The dialog may open a beat after the click, so try to clear it either way.
    await this.dismissDialog(page);
    await page.waitForTimeout(800);
    if (await accepted()) {
      console.log("    [oracle] terms accepted via the dialog's Agree button.");
      return true;
    }

    // Some tenants may use a plain checkbox with no dialog — try a real click on the label, still
    // judged by both signals.
    await page.locator("label[for='legal-disclaimer-checkbox']").first().click({ timeout: 5000 }).catch(() => undefined);
    await this.dismissDialog(page);
    await page.waitForTimeout(800);
    if (await accepted()) {
      console.log("    [oracle] terms accepted via the label.");
      return true;
    }

    const checked = await input.isChecked().catch(() => false);
    const nextOk = await nextBtn.isEnabled().catch(() => true);
    console.log(`    [oracle] terms not accepted (checked=${checked}, next enabled=${nextOk}).`);
    return false;
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
    // Read it back. This field is a Knockout binding too, and an address that did not land is the
    // most likely reason the gate refuses to move — worth ruling out before blaming the click.
    const typed = await emailInput.inputValue().catch(() => "");
    if (typed.trim().toLowerCase() !== email.trim().toLowerCase()) {
      console.log(`    [oracle] the email field reads ${JSON.stringify(typed)} after typing ${JSON.stringify(email)} — not proceeding.`);
      return false;
    }
    console.log(`    [oracle] auth gate — using ${email}`);

    if (!(await this.tickTerms(page))) {
      console.log("    [oracle] could not tick the terms checkbox — not proceeding.");
      return false;
    }

    // Everything after this point is what makes the profile. Stamp the time FIRST: it is what
    // stops a still-recent code from a DIFFERENT tenant being accepted as this one's.
    const requestedAt = new Date();
    const clicked = await this.clickNext(page);
    if (!clicked) {
      console.log("    [oracle] found no Next control on the authentication screen — nothing was submitted.");
      return false;
    }

    // Wait for the page to ACTUALLY move before deciding what happened. The first version read
    // straight after a fixed settle, saw no code field yet, and announced "no code requested —
    // through the gate" while still sitting on the gate. Race a code field, a route change and a
    // validation error against each other, and report whichever wins.
    const deadline = Date.now() + Number(process.env.ORACLE_STEP_TIMEOUT_MS ?? 30_000);
    let sawCodeField = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if ((await this.codeInput(page).count().catch(() => 0)) > 0) { sawCodeField = true; break; }
      if (!(await this.atAuthGate(page))) break; // moved on without asking for a code
      const body = await page.locator("body").innerText().catch(() => "");
      if (/code (has been )?sent|enter the code|verification code|check your email/i.test(body)) { sawCodeField = true; break; }
    }

    if (!sawCodeField && !(await this.atAuthGate(page))) {
      console.log(`    [oracle] through the gate with no code requested — now at ${page.url()}`);
      return true;
    }

    if (!sawCodeField) {
      // Still on the gate and no code screen: the form rejected the submission. Say what it says,
      // rather than reporting a bare false.
      const errors = await this.validationErrors(page).catch(() => [] as string[]);
      const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      console.log(`    [oracle] Next was clicked but the authentication screen did not move (${page.url()}).`);
      if (errors.length) console.log(`    [oracle] the form says: ${errors.join(" · ")}`);
      else console.log(`    [oracle] no validation message on screen. Page reads: ${body.slice(0, 300)}`);
      return false;
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
