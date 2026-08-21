import type { Page } from "playwright";
import { GenericDriver } from "./base.js";
import { isSensitive } from "../llmAgent.js";
import { fetchWorkdayActivateLink, fetchWorkdayResetLink } from "../../knowledge/workdayReset.js";
import type { FieldAnswer, FieldSpec, PageSnapshot, Root } from "../types.js";

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
    const credError = async () => {
      const t = (await page.locator('[data-automation-id*="error"], [data-automation-id*="Error"], [role="alert"]').allInnerTexts().catch(() => [])).join(" ").toLowerCase();
      return /wrong email|incorrect|does not match|locked|couldn.?t find|invalid|not recognized/.test(t);
    };

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
    const clickAny = async (selectors: string[], roleNames: RegExp[] = []): Promise<boolean> => {
      for (const sel of selectors) {
        const el = page.locator(sel).first();
        if (await el.count().catch(() => 0)) { await el.click().catch(() => undefined); return true; }
      }
      for (const rn of roleNames) {
        const el = page.getByRole("button", { name: rn }).first();
        if (await el.isVisible().catch(() => false)) { await el.click().catch(() => undefined); return true; }
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
    let triedCreate = false;
    let triedSignIn = false;
    let triedReset = false;
    for (let step = 0; step < 16; step += 1) {
      if (await count(NEXT_BTN)) return; // reached the application form

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
          await clickAny(
            [
              '[data-automation-id="createAccountSubmitButton"]',
              '[data-automation-id="click_filter"][aria-label*="create" i]',
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
        console.log("[workday] create-account did not advance (likely anti-bot). Stopping.");
        return;
      }

      // Sign In page (single password field + email).
      if (pwCount === 1 && hasEmailField) {
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
          console.log("[workday] sign-in failed (wrong password for the existing account).");
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

      // Resume upload step.
      if (await count('input[type="file"]')) {
        if (!(await count(NEXT_BTN))) await clickRole(/continue|next|save/i);
        await page.waitForTimeout(2000);
        continue;
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
        const txt = (b.textContent || "").trim();
        if (!txt) continue; // nothing rendered yet
        const placeholder = /^(select one|please select|select|choose one|choose)$/i.test(txt);
        let key = b.getAttribute("data-agent-key");
        if (!key) { key = "wd" + (i++); b.setAttribute("data-agent-key", key); }
        // The question text is in the enclosing formField container's text (there
        // is often no <label> and the aria-label is a generic "Select One").
        const ff = b.closest('[data-automation-id^="formField"]');
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
        if (label) out.push({ key, label, required, filled: !placeholder });
      }
      return out;
    })()`)) as Array<{ key: string; label: string; required: boolean; filled: boolean }>;

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
        await page.keyboard?.press("Escape").catch(() => undefined);
        await page.waitForTimeout?.(150);
        await btn.click().catch(() => undefined);
        await page.waitForTimeout?.(400);
        // Scope to the list this button actually controls when it says which one that is; the
        // page-wide query is only a fallback.
        const owns = await btn.getAttribute("aria-controls").catch(() => null);
        const esc = (v: string) => v.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
        const opt = owns
          ? root.locator("#" + esc(owns) + ' [role="option"], #' + esc(owns) + ' [data-automation-id="promptOption"]')
          : root.locator('[role="option"], [data-automation-id="promptOption"]');
        const n = await opt.count().catch(() => 0);
        const list: string[] = [];
        for (let k = 0; k < n; k += 1) {
          const t = ((await opt.nth(k).innerText().catch(() => "")) || "").trim();
          if (t && !/^select one$/i.test(t)) list.push(t);
        }
        if (list.length) options = list;
        await page.keyboard?.press("Escape").catch(() => undefined);
        await page.waitForTimeout?.(150);
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
        out.push({ key, label, required, type: inp.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text', filled: !!inp.value });
      }
      return out;
    })()`)) as Array<{ key: string; label: string; required: boolean; type: string; filled: boolean }>;

    for (const t of texts) {
      if (t.filled || !t.label) continue;
      if (snapshot.fields.some((f) => f.key === t.key || f.label === t.label)) continue;
      snapshot.fields.push({ key: t.key, label: t.label, type: t.type as FieldSpec["type"], required: t.required, sensitive: isSensitive(t.label), filled: false });
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

    const idx = bestOption(texts, answer.value);
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

  private async clearOverlay(root: Root): Promise<void> {
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

  async next(root: Root): Promise<boolean> {
    await this.clearOverlay(root);
    const btn = root.locator(NEXT_BTN).first();
    if (await btn.count().catch(() => 0)) {
      // On the Review step the footer button reads "Submit" — never click it here.
      const text = ((await btn.innerText().catch(() => "")) || "").toLowerCase();
      if (/submit/.test(text)) return false;
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => undefined);
        return true;
      }
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
