import type { Page } from "playwright";
import { GenericDriver } from "./base.js";
import { isSensitive } from "../llmAgent.js";
import { fetchWorkdayActivateLink, fetchWorkdayResetLink } from "../../knowledge/workdayReset.js";
import type { FieldAnswer, FieldSpec, PageSnapshot, Root } from "../types.js";
import { recordAuthAlert, clearAuthAlert, readAuthAlerts } from "../../knowledge/authAlerts.js";
import { preferredHearAboutUs } from "../llmAgent.js";
import { bestBand } from "../../core/factChecks.js";

const NEXT_BTN = '[data-automation-id="pageFooterNextButton"]';
const SUBMIT_BTN = '[data-automation-id="pageFooterSubmitButton"]';
const SIGNIN_BTN = '[data-automation-id="click_filter"][aria-label="Sign In"]';

const normOpt = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Choose the option index best matching `want`: exact → substring → token overlap≥50%; else -1. */
function bestOption(options: string[], want: string): number {
  const w = normOpt(want);
  if (!w) return -1;
  let i = options.findIndex((o) => normOpt(o) === w);
  if (i >= 0) return i;
  const wns = w.replace(/ /g, ""); // space-stripped (e.g. "bachelor s" ~ "bachelors")
  i = options.findIndex((o) => normOpt(o).replace(/ /g, "") === wns);
  if (i >= 0) return i;
  i = options.findIndex((o) => {
    const n = normOpt(o);
    return n.startsWith(w) || w.startsWith(n) || n.includes(w) || w.includes(n);
  });
  if (i >= 0) return i;
  const wt = w.split(" ").filter(Boolean);
  let best = -1;
  let bestScore = 0;
  options.forEach((o, idx) => {
    const toks = new Set(normOpt(o).split(" "));
    const score = wt.filter((t) => toks.has(t)).length / Math.max(1, wt.length);
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  });
  return bestScore >= 0.5 ? best : -1;
}

/**
 * Workday driver. Multi-step, behind account creation / sign-in. Uses Workday's
 * data-automation-id selectors for navigation. NOTE: the auth flow needs live
 * validation on a real Workday posting; custom button-comboboxes (e.g. "How did
 * you hear about us?") are not yet handled by the generic reader.
 */
/**
 * The tenant, which is the boundary a Workday candidate account lives inside.
 *
 * michelinhr.wd3.myworkdayjobs.com and medline.wd5.myworkdayjobs.com are different employers with
 * different accounts, and an account at one says nothing about the other. Keyed on the host so one
 * alarm covers every posting at that employer — twelve identical alarms would bury the eleven
 * other tenants that also need an account.
 */
export function tenantOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.slice(0, 60);
  }
}

export class WorkdayDriver extends GenericDriver {
  readonly type = "workday" as const;

  async detect(page: Page): Promise<boolean> {
    return page.url().toLowerCase().includes("workdayjobs");
  }

  async openApplication(page: Page): Promise<void> {
    const email = process.env.JOB_APP_USERNAME ?? "";
    const password = process.env.JOB_APP_PASSWORD ?? "";
    const count = async (sel: string) => page.locator(sel).count().catch(() => 0);
    const typeInto = async (sel: string, value: string) => {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click().catch(() => undefined);
        await el.fill("").catch(() => undefined);
        await el.pressSequentially(value, { delay: 15 }).catch(() => undefined);
      }
    };
    const clickRole = async (name: RegExp) => {
      const el = page.getByRole("button", { name }).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click().catch(() => undefined);
        return true;
      }
      return false;
    };
    const authErrorText = async () =>
      (await page.locator('[data-automation-id*="error"], [data-automation-id*="Error"], [role="alert"]').allInnerTexts().catch(() => []))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    const credError = async () => /wrong email|incorrect|does not match|locked|couldn.?t find|invalid|not recognized/i.test(await authErrorText());

    /**
     * "No account with that email" vs "wrong password" — Workday reports both through the same
     * error region, and conflating them is what made 16 of 82 failures unfixable.
     *
     * credError() matches "couldn't find", which is Workday's wording for an email it has never
     * seen. The old code read any credError as "the account exists but the password is stale",
     * requested a password reset, and waited out the window for a mail that cannot arrive —
     * Workday does not send a reset for an account that does not exist. Measured: 16 failures
     * across ELEVEN different tenants, and zero Workday reset emails in the inbox over three
     * days. Workday accounts are per-tenant, so a first application at a new employer has no
     * account by definition; "wrong password" was never the common case.
     */
    const noSuchAccount = async () =>
      /couldn.?t find|could not find|no account|not recognized|isn.?t associated|no user/i.test(await authErrorText());

    /**
     * WORKDAY WILL NOT SAY WHETHER THE ACCOUNT EXISTS.
     *
     * 56 of 65 failed sign-ins got this one sentence:
     *
     *   "You may have entered the wrong email address or password or your account might be locked."
     *
     * Three different situations in one string, deliberately — disclosing which would leak whether
     * an address is registered. `noSuchAccount` matches none of it, so every one of those fell
     * through to the password-reset branch and waited out its window for an email Workday never
     * sent, because there was no account to reset. Sixty-five applications stopped there having
     * filled exactly one field.
     */
    const cannotTellWhichCase = async () =>
      /wrong email address or password|email address or password|might be locked/i.test(
        await authErrorText(),
      );

    const accountExists = async () => {
      const t = (await page.locator('[data-automation-id*="error"], [data-automation-id*="Error"], [role="alert"]').allInnerTexts().catch(() => [])).join(" ").toLowerCase();
      return /already (exists|in use|registered|have an account)|account.*(exists|in use)|email.*already/i.test(t);
    };

    // Tenants vary in data-automation-id, so target auth fields generically.
    const emailSel = 'input[data-automation-id="email"], input[type="email"], input[autocomplete="username"], input[name*="email" i]';
    const pwInputs = () => page.locator('input[type="password"], input[data-automation-id="password"], input[data-automation-id="verifyPassword"]');
    const fillNth = async (loc: ReturnType<typeof pwInputs>, i: number, value: string) => {
      const el = loc.nth(i);
      if (await el.count().catch(() => 0)) {
        await el.click().catch(() => undefined);
        await el.fill("").catch(() => undefined);
        await el.pressSequentially(value, { delay: 15 }).catch(() => undefined);
      }
    };
    /**
     * EXISTING IS NOT CLICKING, and this returned true for the difference.
     *
     * It took the first selector that MATCHED, clicked it, swallowed the click's error, and
     * returned true — so a later selector that would have worked was never tried. On Mastercard's
     * Create Account page that is fatal in the most confusing way available:
     *
     *   createAccountSubmitButton  <button tabindex="-2" aria-hidden="true">   inert
     *   click_filter[Create Acc.]  <div role="button" tabindex="0">            the real control
     *
     * Both are 376x40 and both are there. Playwright waits thirty seconds for the aria-hidden
     * button to become actionable, never gets there, the error is dropped, and this reports
     * success. The candidate could SEE the button on screen while the log said create-account did
     * not advance — and it is the same shape as the signInSubmitButton rule already written down
     * in CLAUDE.md, which says the click_filter wrapper is the clickable one.
     *
     * So: a bounded click, and a FAILED click falls through to the next candidate instead of
     * ending the search. Thirty seconds per swallowed attempt was also most of a run's budget.
     */
    const clickAny = async (selectors: string[], roleNames: RegExp[] = []): Promise<boolean> => {
      for (const sel of selectors) {
        const el = page.locator(sel).first();
        if (!(await el.count().catch(() => 0))) continue;
        try {
          await el.click({ timeout: 8000 });
          return true;
        } catch {
          console.log(`[workday] ${sel} is present but would not take a click — trying the next candidate`);
        }
      }
      for (const rn of roleNames) {
        const el = page.getByRole("button", { name: rn }).first();
        if (!(await el.isVisible().catch(() => false))) continue;
        try {
          await el.click({ timeout: 8000 });
          return true;
        } catch {
          // fall through to the next name
        }
      }
      return false;
    };
    /**
     * Some tenants put a sign-in METHOD chooser before the credential form: an SSO button, "OR",
     * and a plain-email button. NVIDIA's reads "Sign in with Google / OR / Sign in with email".
     *
     * That page has no input fields and no footer Next button, so the reader reported
     * "0 field(s), submitReady=false" and the turn loop stopped with "No next control" — 0 filled
     * and no indication why. Take the email branch; the SSO one leads into Google's consent flow,
     * which is not something to drive.
     */
    const chooseEmailSignIn = async (): Promise<boolean> => {
      const el = page
        .getByRole("button", { name: /sign in with email|continue with email|use email/i })
        .or(page.getByRole("link", { name: /sign in with email|continue with email|use email/i }))
        .first();
      if (!(await el.isVisible().catch(() => false))) return false;
      console.log("    [workday] sign-in method chooser — taking the email branch.");
      await el.click().catch(() => undefined);
      await page.waitForTimeout(1200);
      return true;
    };

    const goToSignIn = async () => {
      if (await count('[data-automation-id="signInLink"]')) {
        await page.locator('[data-automation-id="signInLink"]').first().click().catch(() => undefined);
        await chooseEmailSignIn();
        return;
      }
      const el = page.getByRole("link", { name: /^sign in$/i }).or(page.getByRole("button", { name: /^sign in$/i })).first();
      if (await el.count().catch(() => 0)) await el.click().catch(() => undefined);
      await chooseEmailSignIn();
    };

    /** The reverse trip: sign-in page → Create Account, for a tenant we have no account at. */
    const goToCreateAccount = async () => {
      if (await count('[data-automation-id="createAccountLink"]')) {
        await page.locator('[data-automation-id="createAccountLink"]').first().click().catch(() => undefined);
        return;
      }
      const el = page
        .getByRole("link", { name: /create account|sign up|new account/i })
        .or(page.getByRole("button", { name: /create account|sign up|new account/i }))
        .first();
      if (await el.count().catch(() => 0)) await el.click().catch(() => undefined);
    };

    await page.getByRole("button", { name: /accept cookies|accept all/i }).first().click({ timeout: 1500 }).catch(() => undefined);

    // The chooser can BE the landing page — arriving mid-flow on a saved application, with no
    // "Sign in" link to click first — so try it here as well as inside goToSignIn.
    await chooseEmailSignIn();

    // MANUAL_AUTH=1: skip auto create/sign-in/reset. The user signs in themselves
    // in the headed browser (handles email-validation, existing accounts, CAPTCHAs),
    // and we resume filling once the application form (footer Next button) appears.
    if (process.env.MANUAL_AUTH === "1") {
      const waitSec = Number(process.env.MANUAL_AUTH_TIMEOUT_SEC ?? 420);
      console.log(`[workday] MANUAL_AUTH — please sign in and click Apply until you reach the application form. Waiting up to ${waitSec}s...`);
      for (let i = 0; i < Math.ceil(waitSec / 2); i += 1) {
        if (await count(NEXT_BTN)) {
          console.log("[workday] application form detected — taking over to fill.");
          return;
        }
        await page.waitForTimeout(2000);
      }
      console.log("[workday] MANUAL_AUTH timed out waiting for the application form.");
      return;
    }

    // Where we started (the job posting) — used to restart auth after a password reset.
    const startUrl = page.url();

    // Per policy: CREATE ACCOUNT first (uses the current resume via "Autofill with
    // Resume" — never "Use My Last Application", which carries stale data). Only
    // fall back to Sign In when Workday says the account already exists.
    /**
     * A TENANT WE ALREADY KNOW WE CANNOT GET INTO IS NOT TRIED AGAIN.
     *
     * recordAuthAlert has been writing these all along and nothing ever read them back, so every
     * run walked the whole create → sign-in → reset ladder against tenants that had already
     * exhausted it. Thirteen tenants are in that file, all at "create, sign-in and password reset
     * all failed", covering 23 of the failed applications — and one had been hit SEVEN times.
     *
     * That is worse than wasted minutes. Each pass submits another wrong password and another
     * reset request to a real employer's account, which is a good way to get "your account might be
     * locked" to become true, and the tenant's answer is deliberately ambiguous so we cannot tell
     * whether we just did.
     *
     * One account, created by hand, fixes every job on that tenant — which is why the alert counts
     * hits. It expires after twelve hours so a tenant that has been fixed, or has changed its mind,
     * is tried again without anyone having to clear anything; any success clears it outright.
     */
    const tenant = tenantOf(startUrl);
    const HOLD_MS = 12 * 60 * 60 * 1000;
    const known = (await readAuthAlerts().catch(() => []))
      .find((a) => a.tenant === tenant && Date.now() - Date.parse(a.at) < HOLD_MS);
    if (known) {
      const age = Math.round((Date.now() - Date.parse(known.at)) / 60000);
      console.log(
        `[workday] ${tenant} already refused create, sign-in and reset ${known.hits}× (last ${age} min ago) — not asking again. ` +
          `Create the candidate account by hand and every job on this tenant unblocks.`,
      );
      return;
    }

    let triedCreate = false;
    let triedSignIn = false;
    let triedReset = false;
    for (let step = 0; step < 16; step += 1) {
      if (await count(NEXT_BTN)) {
        // We are in. A tenant that previously needed a human no longer does, so stop shouting
        // about it — an alarm nobody can clear is one nobody reads.
        await clearAuthAlert(tenantOf(page.url())).catch(() => undefined);
        return; // reached the application form
      }

      await page.getByRole("button", { name: /accept cookies|accept all/i }).first().click({ timeout: 1000 }).catch(() => undefined);
      const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

      if (/verify your (email|candidate account)|check your (email|inbox)|verification (code|email) (was )?sent|confirm your email|complete setup/i.test(body)) {
        console.log("[workday] account created — fetching the email-validation link from the inbox...");
        const link = await fetchWorkdayActivateLink({ timeoutMs: 180000, pollMs: 15000 });
        if (link) {
          console.log("[workday] validation link received — activating account.");
          await page.goto(link, { waitUntil: "domcontentloaded" }).catch(() => undefined);
          await page.waitForTimeout(4000);
          continue; // activation redirects into the application; loop detects the form
        }
        console.log("[workday] no validation email arrived within the wait window.");
        await recordAuthAlert({
          tenant: tenantOf(page.url()),
          stage: "activation-email",
          detail: "the account was created but no validation email arrived, so it could not be activated",
          email,
        }).catch(() => undefined);
        return;
      }

      // Detect auth pages by password-field count (robust across tenants whose
      // data-automation-ids differ): 2 password fields = Create Account
      // (Password + Verify), 1 = Sign In.
      const pw = page.locator('input[type="password"]');
      const pwCount = await pw.count().catch(() => 0);
      const hasEmailField = (await count(emailSel)) > 0;

      // A sign-in METHOD chooser has NEITHER a password field nor an email field, so every
      // branch below misses it and this loop spins all 16 steps achieving nothing — the run then
      // ends at "0 field(s) / No next control" with no clue why. RTX shows Google / LinkedIn / OR
      // / "Sign in with email"; NVIDIA shows Google / OR / email. Both appear AFTER the Apply
      // click, which is why handling it earlier in openApplication does not help — at that point
      // the page does not exist yet.
      if (pwCount === 0 && !hasEmailField && (await chooseEmailSignIn())) continue;

      // Create Account page — try this FIRST (per policy).
      if (pwCount >= 2) {
        if (!triedCreate) {
          await typeInto(emailSel, email);
          await fillNth(pw, 0, password);
          await fillNth(pw, 1, password);
          await page.locator('input[type="checkbox"]').first().check().catch(() => undefined);
          /**
           * THE WRAPPER FIRST. createAccountSubmitButton is the inert aria-hidden button behind it,
           * exactly as signInSubmitButton is behind the Sign In wrapper — measured on Mastercard,
           * where clicking the wrapper created the account and landed on Candidate Home. The bare
           * click_filter stays last and is a genuine last resort: on a page that has not switched
           * to the create form, the only click_filter is "Sign In".
           */
          await clickAny(
            [
              '[data-automation-id="click_filter"][aria-label*="create" i]',
              '[data-automation-id="createAccountSubmitButton"]',
              '[data-automation-id="click_filter"]',
            ],
            [/create account/i],
          );
          triedCreate = true;
          await page.waitForTimeout(4000);
          if (await accountExists()) {
            console.log("[workday] account already exists → signing in.");
            await goToSignIn();
            await page.waitForTimeout(1500);
          }
          continue;
        }
        // Create submitted but still here (account likely exists) → go to sign-in.
        if (!triedSignIn) {
          await goToSignIn();
          await page.waitForTimeout(1500);
          continue;
        }
        // "Likely anti-bot" was a guess, and it sent the diagnosis down the wrong path for 16
        // runs. The page usually says exactly what is wrong — a password policy, a missing
        // consent box, an email already in use — so print it instead of speculating.
        const said = await authErrorText();
        console.log(
          said
            ? `[workday] create-account did not advance — the form says: "${said.slice(0, 200)}". Stopping.`
            : "[workday] create-account did not advance and the page shows no error (anti-bot, or a control we did not click). Stopping.",
        );
        return;
      }

      // Sign In page (single password field + email).
      if (pwCount === 1 && hasEmailField) {
        /**
         * ORDER IS CREATE, THEN SIGN IN, THEN RESET — decided rather than left to whichever page
         * the tenant happens to open on. Landing on Sign In used to mean signing in first, so a
         * tenant we have no account at spent its attempt on a password we could not have, and the
         * ambiguous "wrong email address or password" then sent it to a reset that goes nowhere.
         * Creating first costs one page load and answers the question the tenant refuses to.
         */
        if (!triedCreate) {
          console.log("[workday] going to Create Account first — create, then sign in, then reset.");
          await goToCreateAccount();
          await page.waitForTimeout(1500);
          continue;
        }
        console.log("[workday] signing in to existing account.");
        await typeInto(emailSel, email);
        await fillNth(pw, 0, password);
        // Workday's real clickable is the "click_filter" wrapper; the underlying
        // signInSubmitButton has tabindex=-2 and isn't clickable. Try click_filter
        // first, then a Sign In button, then Enter. Never the header link.
        await clickAny(['[data-automation-id="click_filter"]', '[data-automation-id="signInSubmitButton"]'], [/^sign in$/i]);
        await page.waitForTimeout(1500);
        await pw.first().press("Enter").catch(() => undefined);
        triedSignIn = true;
        await page.waitForTimeout(3500);
        if (await credError()) {
          const said = await authErrorText();
          // Do NOT reset a password for an account that does not exist. Workday sends nothing,
          // so the wait window is burned for certain — 16 failures across 11 tenants did exactly
          // this. Say which case it is, using the tenant's own words.
          /**
           * CREATE BEFORE RESETTING when the tenant will not say which case it is.
           *
           * Creating is instant and it DIAGNOSES ITSELF: if the account does exist, Workday
           * answers "an account already exists with this email", which accountExists() reads, and
           * the reset branch below is then justified. Resetting first commits to a long wait on an
           * account that may not exist — which is how this failed 56 times. Every Workday employer
           * is a separate tenant, so having an account at one says nothing about the next.
           */
          if ((await noSuchAccount()) || (await cannotTellWhichCase())) {
            const certain = await noSuchAccount();
            console.log(
              certain
                ? `[workday] no account at this tenant for ${email} — the form says: "${said.slice(0, 160)}"`
                : `[workday] the tenant will not say whether the account exists — "${said.slice(0, 120)}"`,
            );
            if (!triedCreate) {
              console.log("[workday] trying Create Account first; a reset would wait on an email that may never come.");
              await goToCreateAccount();
              await page.waitForTimeout(1500);
              triedSignIn = false;
              continue;
            }
            /**
             * Create was already tried. If it reported the account EXISTS, the password is simply
             * wrong and a reset is the right move after all — fall through to it. Otherwise stop.
             */
            if (!triedReset && (await accountExists())) {
              console.log("[workday] create says the account exists, so the password is wrong — resetting after all.");
            } else if (certain) {
              console.log(
                "[workday] create-account was already attempted and sign-in says the account does not exist — " +
                  "stopping. A password reset would wait out its window for an email Workday will never send.",
              );
              return;
            } else {
              console.log(
                "[workday] create-account was already attempted and the tenant still will not say which case " +
                  "this is — trying the reset once before giving up.",
              );
            }
          }
          console.log(`[workday] sign-in failed — the form says: "${said.slice(0, 160)}"`);
          // The account exists but its stored password (from a prior season) differs
          // from JOB_APP_PASSWORD. Reset it via email, then restart auth so sign-in
          // uses the now-matching password. Only attempt this once.
          if (!triedReset) {
            triedReset = true;
            const reset = await this.resetPassword(page, email, password).catch(() => false);
            if (reset) {
              console.log("[workday] password reset complete — restarting sign-in with the new password.");
              await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
              await page.waitForTimeout(2500);
              triedCreate = false; // re-drive: create → "exists" → sign-in (password now matches)
              triedSignIn = false;
              continue;
            }
            console.log("[workday] password reset did not complete — stopping.");
            /**
             * STEP 4: RAISE THE ALARM. Create failed, sign-in failed, and the reset email never
             * came — so there is nothing left for the automation to try, and a human has to open
             * this tenant and make an account. Sixty-five applications reached exactly this point
             * and the only trace was a line in worker.log.
             */
            await recordAuthAlert({
              tenant: tenantOf(page.url()),
              stage: "reset-email",
              detail:
                "create, sign-in and password reset all failed, and no reset email arrived — " +
                "this tenant needs an account created by hand",
              email,
            }).catch(() => undefined);
          }
          return;
        }
        continue;
      }

      // "Start Your Application" dialog → Autofill with Resume (current resume).
      if (/autofill with resume/i.test(body) || /use my last application/i.test(body)) {
        await clickRole(/autofill with resume/i);
        await page.waitForTimeout(4000);
        continue;
      }

      /**
       * Resume upload step — HAND IT OVER rather than fight it.
       *
       * This clicked Continue and looped. On "Autofill with Resume" that can never work: the page
       * will not advance until a file is attached, and this function has no resume to attach — the
       * turn loop owns documents. So it burned all sixteen tries, gave up, and the turn loop then
       * uploaded the resume onto a page nothing knew how to advance from. 130 runs ended there.
       *
       * Returning hands the page to the caller in the state it wants it: upload step reached,
       * signed in, resume not yet attached. It attaches the resume and next() advances.
       */
      if (await count('input[type="file"]')) {
        console.log("[workday] at the resume upload step — handing over so the resume can be attached");
        return;
      }

      // Job posting page → Apply.
      if (await clickRole(/^(apply|continue application)$/i)) {
        await page.waitForTimeout(2500);
        continue;
      }

      break;
    }
  }

  /**
   * Reset an existing account's password to JOB_APP_PASSWORD via the email flow.
   * From the sign-in page: click "Forgot Password", request the reset, read the
   * reset link from the inbox (gog), then set the new password in a side tab so
   * the original application page is preserved. Returns true if the reset landed.
   */
  private async resetPassword(page: Page, email: string, newPassword: string): Promise<boolean> {
    const clickFirst = async (root: Page, selectors: string[]): Promise<boolean> => {
      for (const sel of selectors) {
        const el = root.locator(sel).first();
        if (await el.count().catch(() => 0)) {
          await el.click().catch(() => undefined);
          return true;
        }
      }
      return false;
    };
    const typeInto = async (root: Page, sel: string, value: string) => {
      const el = root.locator(sel).first();
      if (await el.count().catch(() => 0)) {
        await el.click().catch(() => undefined);
        await el.fill("").catch(() => undefined);
        await el.pressSequentially(value, { delay: 15 }).catch(() => undefined);
      }
    };

    // 1. Open the "Forgot Password" flow from the sign-in page.
    const openedForgot = await clickFirst(page, [
      '[data-automation-id="forgotPasswordLink"]',
      'a[data-automation-id*="forgot" i]',
      'button[data-automation-id*="forgot" i]',
    ]);
    if (!openedForgot) {
      // Some tenants surface it as plain link/button text.
      const byText = page.getByRole("link", { name: /forgot.*password/i }).or(page.getByRole("button", { name: /forgot.*password/i })).first();
      if (await byText.count().catch(() => 0)) await byText.click().catch(() => undefined);
      else return false;
    }
    await page.waitForTimeout(1500);

    // 2. Enter the email and submit the reset request. The visible "Reset Password"
    // button varies by tenant, so try the role/text first (most reliable), then
    // known automation ids / the click_filter wrapper.
    await typeInto(page, 'input[data-automation-id="email"], input[type="email"], input[autocomplete="username"], input[name*="email" i]', email);
    await page.keyboard.press("Tab").catch(() => undefined); // commit the email field
    await page.waitForTimeout(300);
    // Workday's real clickable is the click_filter wrapper (the styled button is a
    // non-submitting element with tabindex=-2), same as Sign In. Try it first.
    let submitted = await clickFirst(page, [
      '[data-automation-id="click_filter"][aria-label*="reset" i]',
      '[data-automation-id="resetPasswordSubmitButton"]',
      '[data-automation-id="submitButton"]',
      '[data-automation-id="click_filter"]',
    ]);
    if (!submitted) {
      const roleBtn = page.getByRole("button", { name: /reset password/i }).first();
      if (await roleBtn.count().catch(() => 0)) { await roleBtn.click().catch(() => undefined); submitted = true; }
    }
    // Confirm the request actually went through (page shows a "check your email"
    // confirmation) rather than sitting on the form.
    await page.waitForTimeout(2500);
    const confirmed = /check your (email|inbox)|instructions? (to|have been) sent|email (has been )?sent|reset link/i.test(
      (await page.locator("body").innerText().catch(() => "")).toLowerCase(),
    );
    console.log(`[workday] password-reset ${confirmed ? "confirmed sent" : submitted ? "clicked (no confirmation shown)" : "submit button not found"} — waiting for the email link.`);
    await page.waitForTimeout(1000);

    // 3. Read the reset link from the inbox.
    const link = await fetchWorkdayResetLink({ timeoutMs: 180000, pollMs: 15000 });
    if (!link) {
      console.log("[workday] no reset email arrived within the wait window.");
      return false;
    }
    console.log("[workday] reset link received from email.");

    // 4. Set the new password in a side tab (keeps the application page intact).
    const side = await page.context().newPage();
    try {
      await side.goto(link, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await side.waitForTimeout(2500);
      const pws = side.locator('input[type="password"]');
      if (!(await pws.count().catch(() => 0))) {
        console.log("[workday] reset page had no password field.");
        return false;
      }
      const setPw = async (i: number) => {
        const el = pws.nth(i);
        if (await el.count().catch(() => 0)) {
          await el.click().catch(() => undefined);
          await el.fill("").catch(() => undefined);
          await el.pressSequentially(newPassword, { delay: 15 }).catch(() => undefined);
        }
      };
      await setPw(0);
      await setPw(1);
      await clickFirst(side, [
        '[data-automation-id="submitButton"]',
        '[data-automation-id="click_filter"]',
        'button[type="submit"]',
      ]);
      // Some reset pages label the confirm button "Change Password"/"Reset".
      await side.getByRole("button", { name: /change password|reset password|submit|save/i }).first().click().catch(() => undefined);
      await side.waitForTimeout(3000);
      return true;
    } finally {
      await side.close().catch(() => undefined);
    }
  }

  async resolveRoot(page: Page): Promise<Root> {
    return page;
  }

  // Workday shows a loading/branding modal between steps; wait for it to clear
  // (and dismiss it if it hangs), then wait for fields, or the reader sees 0.
  /**
   * ADD THE ROWS THE HISTORY NEEDS BEFORE READING THE PAGE.
   *
   * Workday renders ONE Work Experience row and expects a click on "Add" for each further one.
   * Nothing in this codebase ever clicked it, so every application entered exactly one job — the
   * candidate has seven on his resume, and the review screenshot showing a single experience was
   * read as a truncated screenshot rather than a missing history. The answering side was always
   * ready: the prompt already carries the whole history "MOST RECENT FIRST" and read() already
   * qualifies a repeated field as "Work Experience 2 — Company*".
   *
   * Runs BEFORE read(), for the same reason pruneSkills does: the review must show the form as it
   * will be submitted, and a row that appears after the read is a row nothing fills.
   *
   * The page script only OBSERVES and clicks a marked button. How many rows to want is decided
   * here, in TypeScript, and the click is CONFIRMED by re-counting: a click that dispatched
   * without adding a row is reported as stuck, never as done.
   */
  async expandRepeatedBlocks(root: Root, wanted: number): Promise<{ section: string; from: number; to: number }[]> {
    if (wanted < 2) return [];
    const MARK = "data-jobapp-add";

    /**
     * Count the rows in a repeated section and mark its Add button.
     *
     * Both counts are returned because I cannot see this tenant's DOM from here and will not
     * guess which signal is the real one: `panels` counts Workday's own repeated panel wrapper,
     * `numbered` counts headings that name a row ("Work Experience 2"). The larger is used and
     * BOTH are logged, so one live run says which to trust.
     */
    const OBSERVE = `(() => {
      const clean = (t) => (t || "").replace(/\\s+/g, " ").trim();
      const out = [];
      const heads = Array.from(document.querySelectorAll("h2, h3, h4, legend"));
      for (const h of heads) {
        const name = clean(h.textContent);
        if (!/^(work experience|employment|education|languages?)\\b/i.test(name)) continue;
        // The section is the nearest ancestor that also holds the Add button for this heading.
        let box = h.parentElement;
        let add = null;
        for (let lv = 0; lv < 6 && box; lv += 1) {
          const buttons = Array.from(box.querySelectorAll('button, [role="button"], [data-automation-id="add-button"]'));
          add = buttons.find((b) => /^(add|add another|add more)$/i.test(clean(b.textContent)) ||
                                    /^(add|add another)$/i.test(clean(b.getAttribute("aria-label")))) || null;
          if (add) break;
          box = box.parentElement;
        }
        if (!box) continue;
        /**
         * COUNT ROWS BY THE FIELD EVERY ROW MUST HAVE.
         *
         * Measured on Michelin: panelSet- wrappers and headings numbered "Work Experience 2"
         * (no backticks in this comment — it lives INSIDE a template literal and one would end it)
         * BOTH returned 0, so the count was pinned at 1 and the confirming re-count could never
         * see a row appear — the Add button was found and clicked and the method still reported
         * "would not take another row". Those two signals are gone.
         *
         * A Work Experience row always carries a Job Title and a Company, and a repeated row
         * always carries its own Delete control, so the row count is however many of those the
         * section holds. All three are reported: this is the second guess at this DOM and the log
         * is what settles it, not me.
         */
        const countOf = (sel) => box.querySelectorAll(sel).length;
        const titles = countOf('[data-automation-id*="jobTitle" i], [data-automation-id*="formField-title" i]');
        const companies = countOf('[data-automation-id*="companyName" i], [data-automation-id*="formField-company" i]');
        const deletes = Array.from(box.querySelectorAll('button, [role="button"]'))
          .filter((b) => /^(delete|remove)$/i.test(clean(b.textContent)) || /^(delete|remove)\\b/i.test(clean(b.getAttribute("aria-label")))).length;
        const panels = Math.max(titles, companies, deletes);
        const numbered = new Set(Array.from(box.querySelectorAll("h3, h4, legend, [aria-label]"))
          .map((e) => clean(e.textContent) || clean(e.getAttribute("aria-label")))
          .map((t) => (t.match(/^(work experience|employment|education|language)\\s+(\\d+)$/i) || [])[2])
          .filter(Boolean)).size;
        let mark = "";
        if (add) {
          mark = add.getAttribute("${MARK}") || String(out.length);
          add.setAttribute("${MARK}", mark);
        }
        out.push({ section: name.slice(0, 40), panels: panels, numbered: numbered, mark: mark, hasAdd: !!add });
      }
      return out;
    })()`;

    type Seen = { section: string; panels: number; numbered: number; mark: string; hasAdd: boolean };
    /**
     * A silent observer is worse than none. The first live run of this method printed NOTHING —
     * not "found", not "no add button" — because the only log lines sat inside a loop over the
     * observed sections and a throw inside the page script came back as an empty array. So the
     * error is reported, and so is an empty observation.
     */
    const observe = async (why: string): Promise<Seen[]> => {
      try {
        return ((await root.evaluate(OBSERVE)) ?? []) as Seen[];
      } catch (err) {
        console.log(`    [workday] repeated-section scan failed (${why}): ${String((err as Error)?.message ?? err).slice(0, 140)}`);
        return [];
      }
    };

    const grown: { section: string; from: number; to: number }[] = [];
    const sections = await observe("first look");
    if (!sections.length) {
      console.log(`    [workday] no repeated section found on this page (wanted ${wanted} row(s))`);
      return [];
    }
    for (const seen of sections) {
      if (!/^(work experience|employment)/i.test(seen.section)) continue; // education/languages: one each
      const count = (s: Seen) => Math.max(s.panels, s.numbered, 1);
      const from = count(seen);
      console.log(`    [workday] "${seen.section}": ${from} row(s) (rowFields=${seen.panels} numbered=${seen.numbered}), add button ${seen.hasAdd ? "found" : "NOT FOUND"}`);
      if (!seen.hasAdd || from >= wanted) continue;

      let have = from;
      while (have < wanted) {
        const button = root.locator(`[${MARK}="${seen.mark}"]`).first();
        if (!(await button.count())) break;
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click().catch(() => undefined);
        /**
         * WAIT FOR THE ROW, DO NOT SLEEP ONCE AND JUDGE.
         *
         * The first live attempt clicked Add, re-counted 400ms later, saw no change and reported
         * "would not take another row" — while the row HAD been added: the very next read found 26
         * fields where the previous run found 17, which is one whole Work Experience row. So the
         * click worked and the confirmation was wrong twice over, once in what it counted and once
         * in how long it gave the page to render it. A wrong confirmation on a live form is worse
         * than none: it makes a working action look broken.
         */
        let now = have;
        for (let look = 0; look < 4 && now <= have; look += 1) {
          await button.page().waitForTimeout(400);
          const after = (await observe("after add")).find((s) => s.section === seen.section);
          now = after ? count(after) : have;
        }
        if (now <= have) {
          console.log(`    [workday] "${seen.section}" would not take another row — stopped at ${have}`);
          break;
        }
        have = now;
      }
      if (have > from) grown.push({ section: seen.section, from, to: have });
    }
    return grown;
  }

  async read(root: Root): Promise<PageSnapshot> {
    const page = root as Page;
    await page.waitForLoadState?.("networkidle").catch(() => undefined);
    await this.clearOverlay(root);

    // Recover from Workday's transient "Something went wrong — please refresh" error.
    for (let retry = 0; retry < 2; retry += 1) {
      const body = (await root.locator("body").innerText().catch(() => "")).toLowerCase();
      if (!/something went wrong|please refresh the page/.test(body)) break;
      console.log("[workday] transient error — refreshing and retrying.");
      await page.reload?.({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout?.(3500);
      await this.clearOverlay(root);
    }

    await root
      .locator('[data-automation-id^="formField"], [data-automation-id="pageFooterNextButton"], input:not([type=hidden])')
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => undefined);
    await page.waitForTimeout?.(1200);

    /**
     * Wait for the page to STOP CHANGING before reading it.
     *
     * The waitFor above is satisfied by whatever is already on screen, which during a page
     * transition is the page we just left. Measured on RTX ZJQCPS, the turn field counts went
     * 17 → 66 → 5 → 66 → 66 → 5 → 5: the loop kept re-reading and re-filling pages it had
     * already done, because "Application Questions 1 of 2" renders a spinner first and its
     * fields arrive later. The debug screenshot caught it exactly — an empty page body, a
     * spinner, and "Save and Continue" still disabled.
     *
     * Counting form fields twice and requiring the same answer is deliberately
     * selector-independent: Workday's spinner markup varies by tenant and version, and a wrong
     * spinner selector fails silently in precisely the same way this bug did.
     */
    const countFields = async (): Promise<number> =>
      (await root.locator('[data-automation-id^="formField"]').count().catch(() => 0)) as number;
    let stableAt = -1;
    for (let wait = 0; wait < 24; wait += 1) {
      const n = await countFields();
      if (n > 0 && n === stableAt) break; // two identical reads → the page has settled
      stableAt = n;
      await page.waitForTimeout?.(500);
    }
    if (stableAt <= 0) {
      // Nothing rendered at all. Say so: an empty read looks identical to "this page has no
      // fields", and the turn loop treats the latter as a reason to advance.
      console.log("    [workday] no form fields rendered after waiting — the page may still be loading");
    }

    const snapshot = await super.read(root);

    // Also capture Workday's custom comboboxes: a <button aria-haspopup="listbox"> whose text IS
    // its value. The real <input> sits beside it at 0x0 with no offsetParent, so super.read —
    // which collects inputs and filters on visibility — never sees these at all.
    //
    // This used to take only buttons showing a placeholder ("Select One"), i.e. only UNFILLED
    // ones. That is why State was invisible on GE Vernova, Northrop and RTX: it showed
    // "Pennsylvania", a real value, so it was skipped — and because it was never offered, the
    // form kept that default while street, city and postal all said Sunnyvale, and Workday
    // rejected the page with "94085 is not a valid postal code for Pennsylvania". A field holding
    // the WRONG value needs answering more than an empty one, not less.
    const combos = (await root.evaluate(`(() => {
      const out = [];
      let i = 0;
      for (const b of document.querySelectorAll('button[aria-haspopup="listbox"]')) {
        if (b.offsetParent === null) continue;
        /**
         * ONLY BUTTONS INSIDE A FORM FIELD.
         *
         * This query is page-wide, and Michelin's header carries "English", "Settings" and the
         * signed-in account as buttons with aria-haspopup="listbox" — indistinguishable from a
         * prompt by that attribute alone. The capture loop opened each one and read or committed
         * from it, and the candidate watched the site CHANGE LANGUAGE mid-application. A wrong
         * value in a field is bad; navigating the chrome of someone's careers site is worse,
         * because everything after it happens on a page we did not mean to be on.
         *
         * Every Workday form control sits in a [data-automation-id="formField-*"] wrapper — the
         * label lookup below has relied on that for as long as this driver has existed. Requiring
         * it costs nothing real and excludes the header entirely.
         */
        if (!b.closest('[data-automation-id^="formField"]')) continue;
        const txt = (b.textContent || "").trim();
        if (!txt) continue; // nothing rendered yet
        const placeholder = /^(select one|please select|select|choose one|choose)$/i.test(txt);
        let key = b.getAttribute("data-agent-key");
        if (!key) { key = "wd" + (i++); b.setAttribute("data-agent-key", key); }
        // The question text is in the enclosing formField container's text (there
        // is often no <label> and the aria-label is a generic "Select One").
        const ff = b.closest('[data-automation-id^="formField"]');
        // The heading path, from the real DOM: h3 is the step ("My Information"), h4 the group
        // ("Legal Name", "Address", "Email Address", "Phone"). Nearest of each ABOVE the field.
        let h3 = "", h4 = "";
        if (ff) {
          const top = ff.getBoundingClientRect().top + window.scrollY;
          for (const h of document.querySelectorAll("h3, h4")) {
            if (h.offsetParent === null) continue;
            const ht = h.getBoundingClientRect().top + window.scrollY;
            if (ht > top) continue;
            const t = (h.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
            if (!t) continue;
            if (h.tagName === "H3") { h3 = t; h4 = ""; } else { h4 = t; }
          }
        }
        const section = [h3, h4].filter(Boolean).join(" / ");
        const raw = ff ? (ff.innerText || "") : (b.getAttribute("aria-label") || "");
        // Required iff the field container shows a red-star asterisk / "required".
        const required = /\\*/.test(raw) || /\\brequired\\b/i.test(raw) || b.getAttribute("aria-required") === "true";
        // Workday folds its inline validation message into the container text once a page has
        // been rejected ("... Error: The field ... is and must have a value"), and that container
        // text is what we use as the question. Left in, the same question arrives TWICE — clean
        // and error-suffixed — and both count as required, so filling one leaves the other
        // "empty" and the gate can never pass. validationErrors() already reports the message.
        const label = raw
          .replace(/\\s*Error:\\s[\\s\\S]*$/i, "")
          .replace(txt, "")   // the button text is the VALUE, not part of the question
          .replace(/select one|please select/gi, "")
          .replace(/\\*/g, "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 160);
        // The button text is the current value, so it doubles as the "is it answered?" signal —
        // and it must be reported, or a WRONG value reads as an empty field and is never fixed.
        if (label) out.push({ section, key, label, required, filled: !placeholder, value: placeholder ? '' : txt });
      }
      return out;
    })()`)) as Array<{ section?: string; key: string; label: string; required: boolean; filled: boolean; value?: string }>;

    // Capture each combobox's real options (open → read → close) so the agent
    // picks an exact option rather than us guessing with fuzzy matching.
    for (const combo of combos) {
      if (snapshot.fields.some((f) => f.label === combo.label)) continue;
      const sel = '[data-agent-key="' + combo.key + '"]';
      let options: string[] | undefined;
      try {
        const btn = root.locator(sel).first();
        await btn.scrollIntoViewIfNeeded().catch(() => undefined);
        // Close anything the PREVIOUS field left open first. The query below is page-wide, so a
        // stray menu is read as if it were ours — the same bug the skills path documents, where
        // searching "Social Media" came back with the country-code list from the field before it.
        // Live consequence here: "Are you currently enrolled in a degree seeking program?" was
        // offered a LANGUAGE list, and the agent answered "English".
        // Close whatever the PREVIOUS field left open and WAIT for it to go — a bare Escape with a
        // 150ms sleep is what let the next field read the last one's menu.
        await this.closeOpenMenu(root);
        await btn.click().catch(() => undefined);
        await page.waitForTimeout?.(400);
        // Scope to the list this button actually controls when it says which one that is; the
        // page-wide query is only a fallback.
        /**
         * ONLY A LIST WE CAN ATTRIBUTE TO THIS CONTROL.
         *
         * The page-wide fallback is what handed "Country / Territory Phone Code*" the seven
         * options of "How Did You Hear About Us?" — Campus Campaign, Career Website — because that
         * field sits directly above it and its menu was still open. Anything picked from that list
         * would have been committed to the wrong question, and the only reason it was noticed is
         * that "is the US in this list?" happened to have an obvious answer. A rule that guesses
         * from someone else's menu is worse than one that declines.
         *
         * So: the listbox the button NAMES, or nothing. Options stay undefined, which the callers
         * already handle — the dialling-code rule says so out loud and the LLM answers from the
         * label instead.
         */
        /**
         * ATTRIBUTION COMES FROM HAVING CLOSED EVERYTHING FIRST.
         *
         * The page-wide read leaked one field's options to the next. My first fix refused to read
         * anything a button did not name via aria-controls — and most Workday prompts do not name
         * one, so "How Did You Hear About Us?" arrived with NO options, the campus rule could not
         * fire, the model guessed "LinkedIn", and ninety seconds burned on a menu that never
         * opened. A field with no options is not safer than a field with the wrong ones; it is the
         * same failure with a longer timeout.
         *
         * closeOpenMenu ran immediately above and WAITED for the prompt to be gone. So a visible
         * activeListContainer now is the one this click opened — attribution without needing the
         * control to volunteer its id. aria-controls is still preferred when offered, because it
         * is direct evidence rather than an inference from ordering.
         */
        const owns = await btn.getAttribute("aria-controls").catch(() => null);
        const esc = (v: string) => v.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
        const openNow = root.locator('[data-automation-id="activeListContainer"]').first();
        const opened = await openNow.isVisible().catch(() => false);
        if (!owns && !opened) {
          console.log(
            `    [workday] "${combo.label.slice(0, 44)}" opened no menu — leaving its options unread ` +
              `rather than reading someone else's`,
          );
        }
        /**
         * THE POPUP LIVES INSIDE THE FIELD'S OWN CONTAINER on some tenants.
         *
         * The fill path has always known this — scopedOptions climbs from the control to its
         * formField ancestor and reads the option rows there — while the read path only ever
         * looked for aria-controls or a global activeListContainer. Michelin has neither, so
         * "How Did You Hear About Us?" was read with NO options, the campus rule could not fire,
         * the model guessed "LinkedIn", and the fill then discovered the real list too late:
         *
         *     · select[LinkedIn] 7 option(s): Campus Campaign | Career Websites | Employee
         *       Referral | Job Board
         *
         * There is no LinkedIn among them. The answer was decided before anyone knew what was on
         * offer. Same locator in both places, so the agent chooses from the list the filler will
         * actually be looking at.
         */
        const nearby = root
          .locator(sel)
          .locator(
            'xpath=ancestor::*[@data-automation-id="multiSelectContainer" or starts-with(@data-automation-id,"formField")][1]',
          )
          .locator(
            'xpath=.//*[@data-automation-id="promptOption" or @role="option"][not(ancestor::*[@data-automation-id="selectedItemList" or @data-automation-id="selectedItem"])]',
          );
        /**
         * THE PORTAL, last, because that is where this tenant puts them.
         *
         * Measured with inspectOpenPrompt: role=option rows whose whole ancestry is `ul > li`,
         * outside any formField and any activeListContainer. Reading them page-wide is what leaked
         * one field's options to the next — but closeOpenMenu ran immediately above and waited for
         * every menu to be gone, so a listbox with rows in it NOW is the one this click opened.
         * That is the same attribution the fill path relies on, and it is why the fill path has
         * been finding seven options all along while the read path found none.
         */
        const portal = root.locator('[role="listbox"]:visible:has([role="option"]) [role="option"]');
        const opt = owns
          ? root.locator("#" + esc(owns) + ' [role="option"], #' + esc(owns) + ' [data-automation-id="promptOption"]')
          : (await nearby.count().catch(() => 0)) > 0
            ? nearby
            : (await portal.count().catch(() => 0)) > 0
              ? portal
              : opened
                ? root.locator(
                    '[data-automation-id="activeListContainer"] [role="option"], ' +
                      '[data-automation-id="activeListContainer"] [data-automation-id="promptOption"]',
                  )
                : root.locator("#__never_matches__");
        /**
         * SAY WHAT EACH STRATEGY SAW. Four attempts at read-time option capture have failed while
         * the fill path finds the options every time, and each attempt was a guess about where the
         * rows live. This prints the counts so the next run answers it instead of me.
         */
        if (process.env.SELECT_TRACE === "1") {
          const counts = {
            ariaControls: owns ? await root.locator("#" + esc(owns) + ' [role="option"]').count().catch(() => -1) : null,
            nearbyFormField: await nearby.count().catch(() => -1),
            portalListbox: await portal.count().catch(() => -1),
            activeList: await root
              .locator('[data-automation-id="activeListContainer"] [role="option"], [data-automation-id="activeListContainer"] [data-automation-id="promptOption"]')
              .count()
              .catch(() => -1),
            anyRoleOption: await root.locator('[role="option"]').count().catch(() => -1),
            anyPromptOption: await root.locator('[data-automation-id="promptOption"]').count().catch(() => -1),
            menuVisible: opened,
          };
          console.log(`      · read-options[${combo.label.slice(0, 26)}] ${JSON.stringify(counts)}`);
        }
        const n = await opt.count().catch(() => 0);
        const list: string[] = [];
        for (let k = 0; k < n; k += 1) {
          const t = ((await opt.nth(k).innerText().catch(() => "")) || "").trim();
          if (t && !/^select one$/i.test(t)) list.push(t);
        }
        if (list.length) options = list;
        await this.closeOpenMenu(root);
      } catch {
        /* leave options undefined */
      }
      // Is that list the WHOLE list, or the first page of one? "How Did You Hear About Us?"
      // offers five genuine choices with five different initials. "Type to Add Skills" and
      // "Field of Study" open on fourteen entries running Accounting → Ancient Studies: every
      // one an A, i.e. page one of a taxonomy with thousands more behind it. Presenting a page
      // as a closed list is why Skills came back "no answer available" while the resume states
      // the skills plainly — the model was told its real answer was not an allowed option.
      const initials = new Set((options ?? []).map((o) => (o[0] ?? "").toUpperCase()));
      const pagedTaxonomy = (options?.length ?? 0) >= 8 && initials.size === 1;

      snapshot.fields.push({
        key: sel,
        section: combo.section,
        value: combo.value,
        label: combo.label,
        type: "single_select",
        required: combo.required,
        options,
        searchable: pagedTaxonomy || undefined,
        sensitive: isSensitive(combo.label),
        widget: "workday-select",
        // A placeholder is not an answer; a real value is — even a WRONG one, which is the
        // whole reason these are reported now instead of skipped. State read "Pennsylvania".
        filled: combo.filled,
      });
    }

    // Capture Workday native text inputs/textareas whose question text lives in
    // the formField container (no <label>), so super.read's label filter drops
    // them — e.g. the "What is your major?" field on Application Questions.
    const texts = (await root.evaluate(`(() => {
      const out = [];
      let i = 0;
      for (const c of document.querySelectorAll('[data-automation-id^="formField"]')) {
        if (c.offsetParent === null) continue;
        // Skip containers that are really a combobox/select (their inner typeahead
        // input isn't a plain text field — the combo path already captures them).
        if (c.querySelector('button[aria-haspopup="listbox"], [role="listbox"], [role="combobox"], [aria-haspopup="listbox"]')) continue;
        const inp = c.querySelector('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([aria-haspopup]), textarea');
        if (!inp || inp.getAttribute('aria-haspopup')) continue;
        if (inp.getAttribute('role') === 'combobox' || inp.getAttribute('aria-autocomplete')) continue; // combobox typeahead input
        const id = inp.getAttribute('id'); const name = inp.getAttribute('name');
        let key = id ? '[id="' + id + '"]' : name ? '[name="' + name + '"]' : null;
        if (!key) { const dk = 'wt' + (i++); inp.setAttribute('data-agent-key', dk); key = '[data-agent-key="' + dk + '"]'; }
        const raw = c.innerText || '';
        const required = /\\*/.test(raw) || /\\brequired\\b/i.test(raw) || inp.getAttribute('aria-required') === 'true' || inp.hasAttribute('required');
        const label = raw.replace(/\\*/g, '').replace(/\\s+/g, ' ').trim().slice(0, 160);
        // Same heading path as the combo scan: h3 is the step, h4 the group.
        let h3 = '', h4 = '';
        {
          const top = c.getBoundingClientRect().top + window.scrollY;
          for (const h of document.querySelectorAll('h3, h4')) {
            if (h.offsetParent === null) continue;
            const ht = h.getBoundingClientRect().top + window.scrollY;
            if (ht > top) continue;
            const t = (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
            if (!t) continue;
            if (h.tagName === 'H3') { h3 = t; h4 = ''; } else { h4 = t; }
          }
        }
        const section = [h3, h4].filter(Boolean).join(' / ');
        out.push({ section, key, label, required, type: inp.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text', filled: !!inp.value, value: String(inp.value || '').slice(0, 300) });
      }
      return out;
    })()`)) as Array<{ section?: string; key: string; label: string; required: boolean; type: string; filled: boolean; value?: string }>;

    for (const t of texts) {
      if (t.filled || !t.label) continue;
      if (snapshot.fields.some((f) => f.key === t.key || f.label === t.label)) continue;
      snapshot.fields.push({ key: t.key, section: t.section, value: t.value, label: t.label, type: t.type as FieldSpec["type"], required: t.required, sensitive: isSensitive(t.label), filled: false });
    }
    return snapshot;
  }

  async fill(root: Root, field: FieldSpec, answer: FieldAnswer): Promise<boolean> {
    if (field.widget !== "workday-select") return super.fill(root, field, answer);
    const page = root as Page;
    const btn = root.locator(field.key).first(); // the button[aria-haspopup=listbox]
    if (!(await btn.count())) return false;
    await btn.scrollIntoViewIfNeeded().catch(() => undefined);
    await btn.click().catch(() => undefined);
    await page.waitForTimeout?.(500);

    const options = root.locator('[role="option"], [data-automation-id="promptOption"]');
    let count = await options.count().catch(() => 0);
    if (count === 0) {
      await page.keyboard?.press("Escape").catch(() => undefined);
      return false;
    }
    const texts: string[] = [];
    for (let i = 0; i < count; i += 1) texts.push(((await options.nth(i).innerText().catch(() => "")) || "").trim());

    let idx = bestOption(texts, answer.value);
    /**
     * A GPA IS A NUMBER, AND A BAND EITHER CONTAINS IT OR DOES NOT.
     *
     * Michelin's review page read "What is your cumulative GPA for your 4 year degree on a 4.0
     * scale? — Below 2.60" for a candidate whose GPA is 3.44. A false statement about someone's
     * academic record, on a finished application, and the candidate spotted it on the screenshot.
     *
     * The answering rule had done its job: it set "3.44". It could not pick a band because this
     * field's options were not captured at read time. So the value reaching the driver was a bare
     * number, and bestOption is a FUZZY STRING match — it has no notion of which band contains
     * 3.44, and "Below 2.60" scored well enough on shared digits and punctuation.
     *
     * Containment is not a matter of resemblance. When the question is about a GPA and the options
     * look like ranges, the band is chosen arithmetically, here, where the options are in hand.
     */
    if (/\bgpa\b|grade point average|overall result/i.test(field.label)) {
      const asNumber = Number.parseFloat(answer.value.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(asNumber) && asNumber > 0) {
        const band = bestBand(texts, asNumber);
        const bandIdx = band ? texts.findIndex((t) => t.trim() === band.trim()) : -1;
        if (bandIdx >= 0 && bandIdx !== idx) {
          console.log(
            `    ↳ GPA ${asNumber} belongs in ${JSON.stringify(band)}, not ` +
              `${JSON.stringify(texts[idx] ?? "(no match)")} — a band contains a number or it does not`,
          );
          idx = bandIdx;
        }
      }
    }
    /**
     * "HOW DID YOU HEAR ABOUT US?" IS A TWO-TIER TREE, and only this question is.
     *
     * It opens on tier one — Campus Campaign, Career Websites, Social Media — and LinkedIn lives
     * INSIDE Social Media, behind a right arrow. So the trace line "the wheel does not move this
     * list — cannot reach LinkedIn" was literally true, and chasing LinkedIn was the wrong goal: a
     * tier-one option is always visible and is a good answer under the standing preference
     * (university > the company's own site > job board > referral > social > other).
     *
     * The preference needs to know the options. Read-time capture has failed to find them four
     * times over, while this path has `texts` in hand every single run — so apply it here, and
     * only after the recorded answer has genuinely not matched.
     */
    if (idx < 0 && /how did you (hear|find|learn)/i.test(field.label)) {
      const preferred = preferredHearAboutUs(texts.filter((t) => t && !/^select one$|^no items/i.test(t)));
      if (preferred) {
        idx = texts.findIndex((t) => t.trim().toLowerCase() === preferred.option.trim().toLowerCase());
        if (idx >= 0) {
          console.log(
            `    ↳ ${JSON.stringify(answer.value)} is not offered at this tier; taking ` +
              `${JSON.stringify(preferred.option)} (${preferred.why})`,
          );
        }
      }
    }
    if (idx < 0) {
      await page.keyboard?.press("Escape").catch(() => undefined);
      return false;
    }
    const chosen = texts[idx];
    await options.nth(idx).click().catch(() => undefined);
    await page.waitForTimeout?.(400);

    // VERIFY. Returning true straight after the click was the reason "How Did You Hear
    // About Us?*" showed a checkmark on every turn while staying empty: the click can
    // silently miss (menu re-render, option scrolled out), and the turn loop trusted our
    // claim, so the field was never retried and never blocked — one job span all 18 turns
    // on the same page and reached no review.
    const shown = ((await btn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    const isPlaceholder = !shown || /^(select one|select\.\.\.|select|search|choose)$/i.test(shown);
    if (isPlaceholder) {
      await page.keyboard?.press("Escape").catch(() => undefined);
      console.log(`[workday-select] "${field.label.slice(0, 40)}" did not take "${chosen}" — still showing "${shown}"`);
      return false;
    }
    return true;
  }

  /**
   * AN OPEN OPTION MENU IS AN OVERLAY, and it eats the click on Save and Continue.
   *
   * Michelin: the run filled the page correctly and reported "clicked Save and Continue but the
   * page did not change". The candidate then clicked the same button himself and it advanced
   * straight to My Experience — so the form was valid and it was OUR click that never landed. A
   * Workday prompt menu renders over the footer; a click dispatched while one is open hits the
   * listbox. A human never sees this because their first click closes the menu and the second
   * hits the button.
   *
   * The stray-options bug is the same open menu seen from the other side: option capture read the
   * "How Did You Hear About Us?" list as if it belonged to "Country / Territory Phone Code*",
   * which can only happen if that menu was still open when the next field was read.
   *
   * Dismiss, WAIT for it to be gone, then click — the rule the consent-banner bug already
   * established. Escape first because it is the widget's own affordance; a click elsewhere would
   * land on whatever is underneath.
   */
  private async closeOpenMenu(root: Root): Promise<void> {
    /**
     * `activeListContainer` ONLY, and it must be visible.
     *
     * The first version of this also matched `[role="listbox"]:visible`, which a Workday
     * multi-select keeps permanently in the page — so it believed a menu was open on every call,
     * pressed Escape three times waiting two seconds each, and logged a failure. Six seconds
     * wasted per call, twice per combobox, and the candidate watching the screen asked why the
     * page was scrolling up and down for so long. An overlay check that fires when there is no
     * overlay is worse than none: it is pure cost plus a false alarm.
     *
     * activeListContainer is the OPEN prompt specifically — the name says so, and it is what the
     * option-capture code has always keyed on.
     */
    /**
     * TWO SHAPES OF OPEN MENU, and this tenant has the one neither earlier version could see.
     *
     * inspectOpenPrompt dumped the option rows: `role=option`, ancestry `ul > li`, NOT inside a
     * formField and NOT inside an activeListContainer — a portal at body level with no automation
     * id anywhere above it. So keying on activeListContainer alone could never close it, which is
     * what "a prompt menu will not close" was reporting, truthfully.
     *
     * The first version DID match [role="listbox"] and was too broad: a multi-select keeps an
     * empty listbox in the page permanently, so every call thought a menu was open and burned six
     * seconds. The discriminator is CONTENT — a listbox holding option rows is an open menu; an
     * empty one is furniture.
     */
    const menu = root
      .locator('[data-automation-id="activeListContainer"]:visible, [role="listbox"]:visible:has([role="option"])')
      .first();
    /**
     * ESCAPE IS NOT ENOUGH, AND AN OPEN MENU EATS EVERY LATER CLICK.
     *
     * On Uline this warning fired hundreds of times in one run: the fields were filled ("✓ Country
     * Phone Code*", "✓ Country", "✓ Phone Device Type"), then a menu stayed open, the next clicks
     * landed on IT instead of the controls, the re-read found those fields empty, and the run ended
     * "3 field(s) the form marks REQUIRED have no answer" — the exact three it had just filled.
     * Reported as a warning the whole time, which is why it read as noise rather than the cause.
     *
     * Escape is only the first thing to try. A click on inert page furniture — the step heading —
     * dismisses a Workday prompt reliably, and unlike a blind body click it cannot land on a
     * control. Tab is tried too: moving focus out of the widget closes the ones that ignore
     * Escape. Each is CONFIRMED by re-checking, so nothing is assumed.
     */
    /**
     * IS ANY MENU ACTUALLY OPEN? Measured: it usually was not.
     *
     * This warning fired 1,383 times against 1,387 option reads - EXACTLY TWICE per read, in
     * lockstep, because closeOpenMenu runs on both sides of every read. A genuinely stuck menu
     * does not arrive on a metronome. The locator was matching something permanently in the page,
     * so every call pressed Escape into nothing, waited, escalated, and logged a failure.
     *
     * Two costs, and I paid both: about 1.8 seconds burned per option read, and - worse - I read
     * the warnings as the CAUSE of three empty fields on Uline and said so. That was correlation
     * dressed up as evidence.
     *
     * A Workday prompt sets aria-expanded="true" on its control while its list is showing. If
     * nothing on the page is expanded, nothing is open, and there is nothing to close.
     */
    /**
     * A LISTBOX IS ONLY OPEN IF ITS OWN CONTROL SAYS SO.
     *
     * My first gate asked whether ANYTHING on the page had aria-expanded="true", and the warning
     * rate barely moved: 15 across 16 option reads, still one per read. Workday keeps expanded
     * regions on the page (collapsible sections), so a page-wide question can never distinguish an
     * open prompt from ordinary furniture. That was a loose test dressed up as a precise one.
     *
     * The precise test is ownership: a prompt's control carries aria-controls pointing at the
     * listbox's id, and aria-expanded="true" while that list is showing. A listbox nobody claims
     * to have expanded is furniture, whatever it contains.
     */
    const reallyOpen = await (root as Page)
      .evaluate(`(() => {
        const lists = Array.from(document.querySelectorAll('[role="listbox"], [data-automation-id="activeListContainer"]'));
        for (const list of lists) {
          const box = list.getBoundingClientRect();
          if (box.width < 2 || box.height < 2) continue;
          if (!list.querySelector('[role="option"], [data-automation-id="promptOption"]')) continue;
          const id = list.getAttribute("id");
          let owner = id ? document.querySelector('[aria-controls="' + id + '"]') : null;
          if (owner && owner.getAttribute("aria-expanded") !== "true") owner = null;
          // No id to key off: accept an expanded control that CONTAINS this list, which is how a
          // Workday multiSelectContainer renders its own open prompt.
          if (!owner) owner = list.closest('[aria-expanded="true"]');
          if (owner) {
            // Mark the control so it can be clicked shut - the way a person closes a dropdown they
            // opened. Returning a selector rather than the node keeps the decision in TypeScript.
            owner.setAttribute("data-jobapp-open-prompt", "1");
            return true;
          }
        }
        return false;
      })()`)
      .catch(() => false);
    if (!reallyOpen) return;

    /**
     * DISMISS IT THE WAY A PERSON WOULD: click somewhere else.
     *
     * The candidate's point, and the research agrees. Nobody closes a dropdown with Escape; they
     * click off it. And the alternatives are known to be unreliable: react-select's own onBlur
     * fires only if the menu got focus first (JedWatson/react-select#2239), and Playwright's
     * focus() has itself been reported to close and reopen these widgets
     * (microsoft/playwright#14254). Clicking outside is what the component actually listens for.
     *
     * The hard part is WHERE. Clicking an element can activate it - which is why the earlier
     * heading click was the safest thing I could think of, and why a blind body click is not
     * acceptable on a live application form. So the point is CHOSEN by asking the page: walk a few
     * candidate coordinates in the margins and take the first whose topmost element is inert (the
     * document, the body, or a plain container with no role, no handler-bearing tag and not part
     * of the menu). If no such point exists, nothing is clicked.
     */
    const page = root as Page;
    const blankPoint = await page
      .evaluate(`(() => {
        const inert = (el) => {
          if (!el) return false;
          const tag = el.tagName.toLowerCase();
          if (["html", "body"].includes(tag)) return true;
          if (["a", "button", "input", "select", "textarea", "label", "svg", "path"].includes(tag)) return false;
          if (el.getAttribute("role")) return false;
          if (el.closest('[role="listbox"], [role="option"], [data-automation-id="activeListContainer"]')) return false;
          if (el.onclick) return false;
          return true;
        };
        const w = window.innerWidth;
        const h = window.innerHeight;
        const candidates = [[6, Math.round(h / 2)], [w - 6, Math.round(h / 2)], [6, Math.round(h / 4)], [Math.round(w / 2), 4]];
        for (const [x, y] of candidates) {
          const el = document.elementFromPoint(x, y);
          if (inert(el)) return JSON.stringify({ x: x, y: y });
        }
        return "";
      })()`)
      .catch(() => "");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await menu.isVisible().catch(() => false))) return;
      if (attempt === 0) {
        /**
         * CLICK THE DROPDOWN AGAIN. It is the first thing a person does with a menu they opened,
         * and it is the one action the widget certainly listens for - it opened on this control,
         * so it toggles shut on it. Tried before clicking away, because clicking away depends on
         * the component watching the document, which react-select is documented not to do
         * reliably (JedWatson/react-select#2239).
         */
        const opener = page.locator('[data-jobapp-open-prompt="1"]').first();
        if (await opener.count().catch(() => 0)) {
          await opener.click({ timeout: 2000 }).catch(() => undefined);
        }
      } else if (attempt === 1 && blankPoint) {
        // What a person does. The coordinate was verified inert above, so this cannot activate
        // anything on the form.
        const { x, y } = JSON.parse(String(blankPoint)) as { x: number; y: number };
        await page.mouse.click(x, y).catch(() => undefined);
      } else if (attempt === 2) {
        // No click at all: take focus off the widget from inside the page.
        await page
          .evaluate('(() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true; })()')
          .catch(() => undefined);
      } else {
        // Last, because it is the one thing people do not do and some widgets ignore it.
        await page.keyboard?.press("Escape").catch(() => undefined);
      }
      const gone = await menu.waitFor({ state: "hidden", timeout: 600 }).then(
        () => true,
        () => false,
      );
      if (gone) return;
    }
    if (await menu.isVisible().catch(() => false)) {
      // Loud, because this is not cosmetic: an open menu swallows the clicks meant for the next
      // field, and the run then reports those fields as unanswered. On Uline that cost three
      // required fields it had already filled.
      console.log(
        "    ⚠ [workday] a prompt menu will NOT close after Escape, Tab and a click on the heading — " +
          "the next clicks will land on it and their fields will read as empty",
      );
    }
  }

  private async clearOverlay(root: Root): Promise<void> {
    await this.closeOpenMenu(root);
    const overlay = root.locator('[role="dialog"], [class*="Spinner" i], [data-automation-id="loadingPanel"]').first();
    if (!(await overlay.count().catch(() => 0))) return;
    // Give it a chance to clear on its own (resume parsing, step transition).
    await overlay.waitFor({ state: "hidden", timeout: 10000 }).catch(() => undefined);
    // If a dialog is still up, close it.
    if (await overlay.isVisible().catch(() => false)) {
      const close = root.locator('[role="dialog"] [aria-label*="close" i], [role="dialog"] button:has-text("×"), [data-automation-id="closeButton"]').first();
      if (await close.count().catch(() => 0)) await close.click().catch(() => undefined);
      else await (root as Page).keyboard?.press("Escape").catch(() => undefined);
      await (root as Page).waitForTimeout?.(1000);
    }
  }

  /**
   * The step, in Workday's own words — h3 is the step name and the progress bar carries "step N of
   * M". inspectWorkdayStructure showed h2 is the JOB TITLE, identical on every step, which is why
   * anything built on h2 could not tell one page from another.
   */
  async pageLabel(root: Root): Promise<string> {
    return (
      ((await root
        .evaluate(`(() => {
          var h3 = document.querySelector('h3');
          var name = ((h3 && h3.textContent) || "").replace(/\\s+/g, " ").trim();
          var cur = document.querySelector('[aria-current="step"]');
          var step = ((cur && cur.textContent) || "").replace(/\\s+/g, " ").trim();
          var m = step.match(/step\\s+(\\d+)\\s+of\\s+(\\d+)/i) || document.body.innerText.match(/current step\\s+(\\d+)\\s+of\\s+(\\d+)/i);
          return (m ? "step " + m[1] + " of " + m[2] + " — " : "") + (name || step || "(unnamed page)");
        })()`)
        .catch(() => "")) as string) || "(page unknown)"
    );
  }

  async next(root: Root): Promise<boolean> {
    await this.clearOverlay(root);
    const page = root as Page;
    let btn = root.locator(NEXT_BTN).first();
    if (!(await btn.count().catch(() => 0))) {
      /**
       * THE AUTOFILL PAGE HAS NO pageFooterNextButton, AND IT IS WHERE 130 RUNS DIED.
       *
       * "Autofill with Resume" is the single commonest place a Workday run stopped at turn one:
       * 130 of the 344 zero-field stops in the log, every one of them reading "0 field(s)" and
       * then "No next control — stopping". The page is an upload step, so it legitimately has no
       * form fields — and its footer control is not the one every later page uses, so next() saw
       * nothing to click and the run ended before the application had begun.
       *
       * The order in the log is what gives it away: openApplication reaches this page and cannot
       * advance because no resume has been attached yet, gives up after its sixteen tries, and the
       * TURN LOOP then attaches the resume — "✓ resume attached (the form is showing the file)" —
       * at which point the page is ready to advance and nothing knows how to.
       *
       * So fall back to the button by its words. Never a submit: the /submit/ guard below applies
       * to whatever is found here, and the SUBMIT blocklist sits in front of all of it.
       */
      const byWords = root
        .getByRole("button", { name: /^(continue|next|save and continue)$/i })
        .first();
      if (!(await byWords.count().catch(() => 0))) return false;
      if (!(await byWords.isVisible().catch(() => false))) return false;
      console.log("    [workday] no page-footer button — advancing with the page's own Continue");
      btn = byWords;
    }
    // On the Review step the footer button reads "Submit" — never click it here.
    const text = ((await btn.innerText().catch(() => "")) || "").toLowerCase();
    if (/submit/.test(text)) return false;
    if (!(await btn.isVisible().catch(() => false))) return false;

    // A DISABLED "Save and Continue" means the form is refusing to advance — required fields are
    // still empty. Clicking it changes nothing, but returning true told the loop it had advanced,
    // so the loop waited, re-read the SAME page, re-filled it, and went round again. Measured on
    // RTX ZJQCPS: field counts cycled 66 → 5 → 66 → 66 → 5 → 66 for nine turns.
    const disabled =
      (await btn.getAttribute("aria-disabled").catch(() => null)) === "true" ||
      (await btn.isDisabled().catch(() => false));
    if (disabled) {
      console.log("    [workday] Save and Continue is disabled — the form will not advance from here");
      return false;
    }

    // What page are we on now? Compared after the click, so "advanced" means the page actually
    // TURNED rather than the click having been dispatched. Without this the loop treats a failed
    // navigation as progress.
    /**
     * THE STEP NAME AND THE PATH — not the job title and a field count.
     *
     * This used to read `h2` plus the number of form fields. inspectWorkdayStructure showed what
     * h2 actually is: the JOB TITLE, "Summer 2027 Internship: Data Engineering (Ardmore, OK)",
     * identical on every step of the flow. So the only part that ever varied was the field COUNT —
     * and Workday adds fields when it annotates a rejected page with validation text, 15 becoming
     * 17. A click that failed and produced an error message therefore looked like the page had
     * TURNED. The loop took a fresh turn on the same page and filled it all again, which is what
     * the candidate watched happen.
     *
     * The step name is h3 ("My Information", "My Experience"), and the path changes with it. Both
     * move on a real advance; neither moves because an error appeared.
     */
    const signature = async (): Promise<string> =>
      (await root
        .evaluate(`(() => {
          var h3 = document.querySelector('h3');
          var step = document.querySelector('[aria-current="step"], [data-automation-id*="progressBar" i] [aria-current]');
          return [
            ((h3 && h3.textContent) || "").replace(/\\s+/g, " ").trim(),
            ((step && step.textContent) || "").replace(/\\s+/g, " ").trim(),
            location.pathname,
          ].join("|");
        })()`)
        .catch(() => "")) as string;

    const before = await signature();
    await btn.click().catch(() => undefined);
    for (let wait = 0; wait < 24; wait += 1) {
      await page.waitForTimeout?.(500);
      const now = await signature();
      if (now && now !== before) return true; // the page turned
    }
    /**
     * SAY WHAT IS ON THE SCREEN, not just that nothing happened.
     *
     * "clicked Save and Continue but the page did not change" was the whole report, three runs in
     * a row, while the screen said in a red box at the top: "Errors Found — 1. Error - Please
     * check one of the boxes below: The field ... is required and must have a value." I found that
     * by cropping the debug screenshot BY HAND, which the candidate rightly asked why the run
     * could not do for itself.
     *
     * The form knows why it refused and puts it on the page. Reading it costs one call, turns an
     * opaque stall into a diagnosis, and is the difference between "it will not advance" and "it
     * will not advance BECAUSE this required question is unanswered".
     */
    const said = await this.validationErrors(root).catch(() => [] as string[]);
    if (said.length) {
      console.log(`    [workday] clicked Save and Continue and the page refused — it says:`);
      for (const line of said.slice(0, 4)) console.log(`       • ${line.slice(0, 150)}`);
    } else {
      console.log(
        `    [workday] clicked Save and Continue but the page did not change (${before}) — and it shows no error, ` +
          `so the click may have been swallowed rather than rejected`,
      );
    }
    return false;
  }

  async submit(root: Root): Promise<boolean> {
    const submitBtn = root.locator(SUBMIT_BTN).first();
    if (await submitBtn.count().catch(() => 0)) {
      await submitBtn.click().catch(() => undefined);
      return true;
    }
    // Some tenants reuse the footer next button, labeled "Submit", on Review.
    const nextBtn = root.locator(NEXT_BTN).first();
    if (await nextBtn.count().catch(() => 0)) {
      const text = ((await nextBtn.innerText().catch(() => "")) || "").toLowerCase();
      if (/submit/.test(text)) {
        await nextBtn.click().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  protected async hasSubmit(root: Root): Promise<boolean> {
    if ((await root.locator(SUBMIT_BTN).count().catch(() => 0)) > 0) return true;
    // Review step: the footer next button is labeled "Submit".
    const btn = root.locator(NEXT_BTN).first();
    if (await btn.count().catch(() => 0)) {
      const text = ((await btn.innerText().catch(() => "")) || "").toLowerCase();
      return /submit/.test(text);
    }
    return false;
  }

  protected async hasNext(root: Root): Promise<boolean> {
    return (await root.locator(NEXT_BTN).count().catch(() => 0)) > 0;
  }
}
